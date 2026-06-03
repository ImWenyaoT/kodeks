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
        ({"DEEPSEEK_API_KEY": "sk-old"}, "DEEPSEEK_API_KEY is unsupported"),
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
