import json
from pathlib import Path

import pytest

from kodeks.config import (
    DEFAULT_DEEPSEEK_MODEL,
    ModelConfigurationError,
    load_configured_model_catalog,
    load_model_runtime_env,
    resolve_kodeks_config_path,
    resolve_model_client_options,
)


def test_model_catalog_only_exposes_deepseek(tmp_path):
    """Model catalog keeps only DeepSeek options, including built-in defaults."""

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "model": {
                    "primary": "qwen/qwen3.6",
                    "providers": {
                        "qwen": {
                            "api": "chat-completions",
                            "baseURL": "http://127.0.0.1:8010/v1",
                            "apiKey": "local-placeholder",
                            "models": [{"id": "qwen3.6", "name": "Qwen 3.6"}],
                        },
                        "deepseek": {
                            "api": "chat-completions",
                            "baseURL": "https://api.deepseek.com",
                            "apiKey": "deepseek-placeholder",
                            "models": [{"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro"}],
                        },
                    },
                }
            }
        )
    )

    catalog = load_configured_model_catalog({"KODEKS_CONFIG_PATH": str(config_path)})

    assert catalog.primary == f"deepseek/{DEFAULT_DEEPSEEK_MODEL}"
    assert [model.ref for model in catalog.models] == [
        f"deepseek/{DEFAULT_DEEPSEEK_MODEL}",
        "deepseek/deepseek-v4-flash",
    ]
    assert catalog.models[0].requires_bridge is True


def test_config_expands_env_and_deepseek_provider(tmp_path):
    """User config maps the DeepSeek provider ref to the env contract."""

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "model": {
                    "primary": "deepseek/deepseek-v4-pro",
                    "providers": {
                        "deepseek": {
                            "api": "chat-completions",
                            "baseURL": "${DEEPSEEK_BASE_URL}",
                            "apiKey": "deepseek-placeholder",
                            "models": [{"id": "deepseek-v4-pro"}],
                        }
                    },
                }
            }
        )
    )

    env = load_model_runtime_env(
        {
            "KODEKS_CONFIG_PATH": str(config_path),
            "DEEPSEEK_BASE_URL": "https://api.deepseek.com",
        },
        "deepseek/deepseek-v4-pro",
    )

    assert env["KODEKS_MODEL_PROVIDER"] == "moonbridge"
    assert env["KODEKS_CHAT_COMPLETIONS_BASE_URL"] == "https://api.deepseek.com"
    assert env["KODEKS_CHAT_COMPLETIONS_MODEL"] == "deepseek-v4-pro"


def test_requested_deepseek_model_ref_selects_upstream_model():
    """Requested DeepSeek model refs select the upstream Chat Completions model."""

    env = load_model_runtime_env(
        {"DEEPSEEK_API_KEY": "deepseek-placeholder"},
        "deepseek/deepseek-v4-flash",
    )

    assert env["KODEKS_MODEL_PROVIDER"] == "moonbridge"
    assert env["KODEKS_CHAT_COMPLETIONS_MODEL"] == "deepseek-v4-flash"


def test_workspace_dotenv_configures_runtime_env(tmp_path):
    """Workspace `.env` configures the basic runtime env contract."""

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".env").write_text(
        "\n".join(
            [
                "# local development secrets",
                "export DEEPSEEK_API_KEY=dotenv-placeholder",
                'DEEPSEEK_BASE_URL="https://dotenv.example.com"',
                "DEEPSEEK_MODEL=dotenv-model # inline comment",
            ]
        )
    )

    env = load_model_runtime_env({"KODEKS_WORKSPACE_ROOT": str(workspace)})

    assert env["KODEKS_CHAT_COMPLETIONS_API_KEY"] == "dotenv-placeholder"
    assert env["KODEKS_CHAT_COMPLETIONS_BASE_URL"] == "https://dotenv.example.com"
    assert env["KODEKS_CHAT_COMPLETIONS_MODEL"] == "dotenv-model"


def test_simple_model_env_aliases_configure_runtime_env():
    """Friendly env aliases map to the canonical runtime env names."""

    env = load_model_runtime_env(
        {
            "API_KEY": "generic-placeholder",
            "BASE_URL": "https://generic.example.com",
            "MODEL": "generic-model",
        }
    )

    assert env["KODEKS_CHAT_COMPLETIONS_API_KEY"] == "generic-placeholder"
    assert env["KODEKS_CHAT_COMPLETIONS_BASE_URL"] == "https://generic.example.com"
    assert env["KODEKS_CHAT_COMPLETIONS_MODEL"] == "generic-model"
    assert resolve_model_client_options(env) == {
        "provider": "moonbridge",
        "apiKey": "bridge",
        "baseURL": "http://127.0.0.1:38440/v1",
        "model": "bridge",
        "reasoningEffort": "high",
    }


def test_canonical_model_env_overrides_aliases():
    """Canonical env names win over shorter aliases in the same source."""

    env = load_model_runtime_env(
        {
            "API_KEY": "alias-placeholder",
            "KODEKS_CHAT_COMPLETIONS_API_KEY": "canonical-placeholder",
        }
    )

    assert env["KODEKS_CHAT_COMPLETIONS_API_KEY"] == "canonical-placeholder"


def test_process_env_overrides_workspace_dotenv(tmp_path):
    """Explicit process-style env wins over project `.env` values."""

    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / ".env").write_text(
        "DEEPSEEK_API_KEY=dotenv-placeholder\n"
    )

    env = load_model_runtime_env(
        {
            "KODEKS_WORKSPACE_ROOT": str(workspace),
            "API_KEY": "process-placeholder",
        }
    )

    assert env["KODEKS_CHAT_COMPLETIONS_API_KEY"] == "process-placeholder"


def test_dotenv_values_expand_json_config_vars(tmp_path):
    """Workspace `.env` values are available to JSON config interpolation."""

    workspace = tmp_path / "workspace"
    config_dir = workspace / ".kodeks"
    config_dir.mkdir(parents=True)
    (workspace / ".env").write_text("DEEPSEEK_BASE_URL=https://dotenv.example.com\n")
    (config_dir / "config.json").write_text(
        json.dumps(
            {
                "model": {
                    "chatCompletions": {
                        "apiKey": "json-placeholder",
                        "baseURL": "${DEEPSEEK_BASE_URL}",
                        "model": "json-model",
                    }
                }
            }
        )
    )

    env = load_model_runtime_env({"KODEKS_WORKSPACE_ROOT": str(workspace)})

    assert env["KODEKS_CHAT_COMPLETIONS_BASE_URL"] == "https://dotenv.example.com"
    assert env["KODEKS_CHAT_COMPLETIONS_MODEL"] == "json-model"


def test_workspace_config_is_discovered_before_user_config(tmp_path, monkeypatch):
    """Workspace `.kodeks/config.json` is discovered as the project-local config."""

    workspace = tmp_path / "workspace"
    home = tmp_path / "home"
    user_config_dir = home / ".kodeks"
    workspace_config_dir = workspace / ".kodeks"
    user_config_dir.mkdir(parents=True)
    workspace_config_dir.mkdir(parents=True)
    monkeypatch.setattr(Path, "home", lambda: home)
    user_config_path = user_config_dir / "config.json"
    workspace_config_path = workspace_config_dir / "config.json"
    user_config_path.write_text(
        json.dumps(
            {
                "model": {
                    "chatCompletions": {
                        "apiKey": "user-placeholder",
                        "baseURL": "https://user.example.com",
                        "model": "user-model",
                    }
                }
            }
        )
    )
    workspace_config_path.write_text(
        json.dumps(
            {
                "model": {
                    "chatCompletions": {
                        "apiKey": "workspace-placeholder",
                        "baseURL": "https://workspace.example.com",
                        "model": "workspace-model",
                    }
                }
            }
        )
    )

    auto_env = {"KODEKS_WORKSPACE_ROOT": str(workspace)}
    assert resolve_kodeks_config_path(auto_env) == workspace_config_path.resolve()
    assert (
        load_model_runtime_env(auto_env)["KODEKS_CHAT_COMPLETIONS_BASE_URL"]
        == "https://workspace.example.com"
    )


def test_explicit_config_dir_overrides_workspace_config(tmp_path):
    """Explicit config directory overrides the auto-discovered workspace config."""

    workspace = tmp_path / "workspace"
    explicit_config_dir = tmp_path / "explicit" / ".kodeks"
    workspace_config_dir = workspace / ".kodeks"
    explicit_config_dir.mkdir(parents=True)
    workspace_config_dir.mkdir(parents=True)
    explicit_config_path = explicit_config_dir / "config.json"
    workspace_config_path = workspace_config_dir / "config.json"
    explicit_config_path.write_text(
        json.dumps(
            {
                "model": {
                    "chatCompletions": {
                        "apiKey": "explicit-placeholder",
                        "baseURL": "https://explicit.example.com",
                        "model": "explicit-model",
                    }
                }
            }
        )
    )
    workspace_config_path.write_text(
        json.dumps(
            {
                "model": {
                    "chatCompletions": {
                        "apiKey": "workspace-placeholder",
                        "baseURL": "https://workspace.example.com",
                        "model": "workspace-model",
                    }
                }
            }
        )
    )

    env = {
        "KODEKS_CONFIG_DIR": str(explicit_config_dir),
        "KODEKS_WORKSPACE_ROOT": str(workspace),
    }

    assert resolve_kodeks_config_path(env) == explicit_config_path.resolve()
    assert (
        load_model_runtime_env(env)["KODEKS_CHAT_COMPLETIONS_BASE_URL"]
        == "https://explicit.example.com"
    )


def test_config_file_adapter_fields_do_not_enable_model_routing(tmp_path):
    """Old config-file adapter fields no longer configure the runtime route."""

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "model": {
                    "provider": "moonbridge",
                    "bridge": {
                        "enabled": True,
                        "baseURL": "http://127.0.0.1:38440/v1",
                        "model": "bridge",
                    },
                }
            }
        )
    )

    env = load_model_runtime_env({"KODEKS_CONFIG_PATH": str(config_path)})

    assert "KODEKS_MODEL_PROVIDER" not in env
    assert "KODEKS_BRIDGE_ENABLED" not in env
    assert "KODEKS_BRIDGE_BASE_URL" not in env
    assert resolve_model_client_options(env) is None


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        (
            {"KODEKS_BRIDGE_DEEPSEEK_BASE_URL": "https://old.test/v1"},
            "KODEKS_BRIDGE_DEEPSEEK_BASE_URL is unsupported",
        ),
        (
            {"MOONBRIDGE_DEEPSEEK_MODEL": "old-model"},
            "MOONBRIDGE_DEEPSEEK_MODEL is unsupported",
        ),
        ({"MOONBRIDGE_API_KEY": "moon-old"}, "MOONBRIDGE_API_KEY is unsupported"),
        (
            {"KODEKS_MODEL_PROVIDER": "deepseek"},
            "MoonBridge remains an internal adapter",
        ),
    ],
)
def test_unsupported_aliases_fail_with_supported_config_guidance(env, expected):
    """Unsupported model env names do not silently change runtime behavior."""

    with pytest.raises(ModelConfigurationError) as error:
        resolve_model_client_options(env)

    assert expected in str(error.value)


def test_direct_openai_provider_is_outside_product_boundary():
    """Direct OpenAI/Responses model routing is not part of the product boundary."""

    with pytest.raises(ModelConfigurationError) as error:
        resolve_model_client_options({"KODEKS_MODEL_PROVIDER": "openai"})

    assert "outside the Kodeks product boundary" in str(
        error.value
    )
