import json

import pytest

from kodeks.config import (
    DEFAULT_DEEPSEEK_MODEL,
    ModelConfigurationError,
    load_configured_model_catalog,
    load_model_runtime_env,
    resolve_model_client_options,
)


def test_model_catalog_preserves_default_and_provider_refs(tmp_path):
    """Model catalog keeps DeepSeek first and hides half-configured providers."""

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
                        "openai": {
                            "api": "responses",
                            "apiKey": "",
                            "models": [{"id": "gpt-5.4-mini"}],
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
        "qwen/qwen3.6",
        "openai/gpt-5.4-mini",
    ]
    assert catalog.models[1].requires_bridge is True
    assert catalog.models[2].requires_bridge is False


def test_config_expands_env_and_selected_provider(tmp_path):
    """User config maps provider/model refs to the env contract."""

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "model": {
                    "primary": "qwen/qwen3.6",
                    "providers": {
                        "qwen": {
                            "api": "chat-completions",
                            "baseURL": "${QWEN_BASE_URL}",
                            "apiKey": "local-placeholder",
                            "models": [{"id": "qwen3.6"}],
                        }
                    },
                }
            }
        )
    )

    env = load_model_runtime_env(
        {
            "KODEKS_CONFIG_PATH": str(config_path),
            "QWEN_BASE_URL": "http://127.0.0.1:8010/v1",
        },
        "qwen/qwen3.6",
    )

    assert env["KODEKS_MODEL_PROVIDER"] == "moonbridge"
    assert env["KODEKS_CHAT_COMPLETIONS_BASE_URL"] == "http://127.0.0.1:8010/v1"
    assert env["KODEKS_CHAT_COMPLETIONS_MODEL"] == "qwen3.6"


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


def test_hosted_tools_are_direct_openai_only():
    """Hosted OpenAI tools are ignored when routing through MoonBridge."""

    openai = resolve_model_client_options(
        {
            "KODEKS_MODEL_PROVIDER": "openai",
            "KODEKS_RESPONSES_API_KEY": "responses-key",
            "KODEKS_OPENAI_HOSTED_TOOLS": (
                "web_search_preview,unknown,web_search_preview"
            ),
        }
    )
    moonbridge = resolve_model_client_options(
        {
            "KODEKS_CHAT_COMPLETIONS_API_KEY": "chat-key",
            "KODEKS_CHAT_COMPLETIONS_BASE_URL": "https://qwen.test/v1",
            "KODEKS_CHAT_COMPLETIONS_MODEL": "qwen-coder",
            "KODEKS_OPENAI_HOSTED_TOOLS": "web_search_preview",
        }
    )

    assert openai is not None
    assert openai["hostedTools"] == ["web_search_preview"]
    assert moonbridge is not None
    assert moonbridge["provider"] == "moonbridge"
    assert "hostedTools" not in moonbridge
