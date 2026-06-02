import json

import pytest

from kodeks.config import (
    DEFAULT_DEEPSEEK_MODEL,
    ModelConfigurationError,
    load_configured_model_catalog,
    load_model_runtime_env,
    resolve_model_client_options,
)


def test_model_catalog_only_exposes_deepseek(tmp_path):
    """Model catalog keeps only the configured DeepSeek model."""

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


def test_lmstudio_embeddings_config_maps_to_openai_compatible_env(tmp_path):
    """LM Studio embeddings use the OpenAI-compatible env contract."""

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "embeddings": {
                    "enabled": True,
                    "provider": "lmstudio",
                    "baseURL": "http://127.0.0.1:1234/v1",
                    "apiKey": "local-placeholder",
                    "model": "Qwen/Qwen3-Embedding-0.6B",
                }
            }
        )
    )

    env = load_model_runtime_env({"KODEKS_CONFIG_PATH": str(config_path)})

    assert env["KODEKS_EMBEDDINGS_ENABLED"] == "true"
    assert env["KODEKS_EMBEDDINGS_PROVIDER"] == "lmstudio"
    assert env["KODEKS_OPENAI_COMPAT_BASE_URL"] == "http://127.0.0.1:1234/v1"
    assert env["KODEKS_OPENAI_COMPAT_API_KEY"] == "local-placeholder"
    assert env["KODEKS_OPENAI_COMPAT_EMBED_MODEL"] == "Qwen/Qwen3-Embedding-0.6B"


@pytest.mark.parametrize(
    ("env", "expected"),
    [
        ({"DEEPSEEK_API_KEY": "sk-old"}, "KODEKS_CHAT_COMPLETIONS_API_KEY"),
        (
            {"KODEKS_BRIDGE_DEEPSEEK_BASE_URL": "https://old.test/v1"},
            "KODEKS_CHAT_COMPLETIONS_BASE_URL",
        ),
        (
            {"MOONBRIDGE_DEEPSEEK_MODEL": "old-model"},
            "KODEKS_CHAT_COMPLETIONS_MODEL",
        ),
        ({"MOONBRIDGE_API_KEY": "moon-old"}, "KODEKS_BRIDGE_API_KEY"),
        ({"KODEKS_MODEL_PROVIDER": "deepseek"}, 'Use "moonbridge" instead'),
    ],
)
def test_removed_aliases_fail_with_migration_guidance(env, expected):
    """Deprecated model env names do not silently change runtime behavior."""

    with pytest.raises(ModelConfigurationError) as error:
        resolve_model_client_options(env)

    assert expected in str(error.value)


def test_direct_openai_provider_is_removed():
    """Direct OpenAI/Responses model routing no longer participates in runtime config."""

    with pytest.raises(ModelConfigurationError) as error:
        resolve_model_client_options(
            {
                "KODEKS_MODEL_PROVIDER": "openai",
                "KODEKS_RESPONSES_API_KEY": "responses-key",
            }
        )

    assert "Direct OpenAI/Responses model providers have been removed" in str(
        error.value
    )


def test_hosted_tools_are_ignored_for_deepseek_route():
    """Hosted OpenAI tools are ignored when routing through DeepSeek/MoonBridge."""

    moonbridge = resolve_model_client_options(
        {
            "KODEKS_CHAT_COMPLETIONS_API_KEY": "chat-key",
            "KODEKS_CHAT_COMPLETIONS_BASE_URL": "https://api.deepseek.com",
            "KODEKS_CHAT_COMPLETIONS_MODEL": DEFAULT_DEEPSEEK_MODEL,
            "KODEKS_OPENAI_HOSTED_TOOLS": "web_search_preview",
        }
    )

    assert moonbridge is not None
    assert moonbridge["provider"] == "moonbridge"
    assert "hostedTools" not in moonbridge
