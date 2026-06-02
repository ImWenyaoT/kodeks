"""Runtime configuration compatibility layer for the Python Kodeks service."""

from __future__ import annotations

import json
import os
import platform
import re
from collections.abc import Mapping, MutableMapping
from pathlib import Path
from typing import Any, Literal
from urllib.parse import urlparse

from .contracts import ConfiguredModelCatalog, ConfiguredModelOption, ReasoningEffort

RuntimeEnv = Mapping[str, str | None]

CONFIG_FILE_NAME = "config.json"
CONFIG_DIR_NAME = ".kodeks"
DEFAULT_CHAT_COMPLETIONS_BASE_URL = "https://api.deepseek.com"
DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro"
DEFAULT_DEEPSEEK_MODEL_REF = f"deepseek/{DEFAULT_DEEPSEEK_MODEL}"
DEFAULT_BRIDGE_API_KEY = "bridge"
DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:38440/v1"
DEFAULT_BRIDGE_MODEL = "bridge"
DEFAULT_BRIDGE_REASONING_EFFORT: ReasoningEffort = "high"
DEFAULT_OPENAI_MODEL = "gpt-5.4-mini"
DEFAULT_OPENAI_REASONING_EFFORT: ReasoningEffort = "medium"
LOCAL_ENDPOINT_API_KEY = "not-needed"
SUPPORTED_REASONING_EFFORTS = {"none", "low", "medium", "high", "xhigh"}

DEPRECATED_ENV_MIGRATIONS = {
    "DEEPSEEK_API_KEY": "KODEKS_CHAT_COMPLETIONS_API_KEY",
    "DEEPSEEK_BASE_URL": "KODEKS_CHAT_COMPLETIONS_BASE_URL",
    "DEEPSEEK_MODEL": "KODEKS_CHAT_COMPLETIONS_MODEL",
    "DEEPSEEK_REASONING_EFFORT": "KODEKS_BRIDGE_REASONING_EFFORT",
    "KODEKS_BRIDGE_DEEPSEEK_API_KEY": "KODEKS_CHAT_COMPLETIONS_API_KEY",
    "KODEKS_BRIDGE_DEEPSEEK_BASE_URL": "KODEKS_CHAT_COMPLETIONS_BASE_URL",
    "KODEKS_BRIDGE_DEEPSEEK_MODEL": "KODEKS_CHAT_COMPLETIONS_MODEL",
    "MOONBRIDGE_API_KEY": "KODEKS_BRIDGE_API_KEY",
    "MOONBRIDGE_BASE_URL": "KODEKS_BRIDGE_BASE_URL",
    "MOONBRIDGE_ENABLED": "KODEKS_BRIDGE_ENABLED",
    "MOONBRIDGE_MODEL": "KODEKS_BRIDGE_MODEL",
    "MOONBRIDGE_REASONING_EFFORT": "KODEKS_BRIDGE_REASONING_EFFORT",
    "MOONBRIDGE_DEEPSEEK_API_KEY": "KODEKS_CHAT_COMPLETIONS_API_KEY",
    "MOONBRIDGE_DEEPSEEK_BASE_URL": "KODEKS_CHAT_COMPLETIONS_BASE_URL",
    "MOONBRIDGE_DEEPSEEK_MODEL": "KODEKS_CHAT_COMPLETIONS_MODEL",
}
DEPRECATED_PROVIDER_VALUES = {
    "bridge": "moonbridge",
    "deepseek": "moonbridge",
    "chat-completions": "moonbridge",
}


class ModelConfigurationError(RuntimeError):
    """Stable configuration error surfaced as `model_configuration_error`."""

    code = "model_configuration_error"


def resolve_kodeks_config_dir(env: RuntimeEnv | None = None) -> Path:
    """Resolve the user-level Kodeks config directory."""

    runtime_env = os.environ if env is None else env
    override = _string_value(runtime_env.get("KODEKS_CONFIG_DIR"))
    if override is not None:
        return Path(override).expanduser().resolve()
    return Path.home() / CONFIG_DIR_NAME


def resolve_kodeks_config_path(env: RuntimeEnv | None = None) -> Path:
    """Resolve the Kodeks config path, including legacy platform fallbacks."""

    runtime_env = os.environ if env is None else env
    override = _string_value(runtime_env.get("KODEKS_CONFIG_PATH"))
    if override is not None:
        return Path(override).expanduser().resolve()
    canonical = resolve_kodeks_config_dir(runtime_env) / CONFIG_FILE_NAME
    if canonical.exists() or _string_value(runtime_env.get("KODEKS_CONFIG_DIR")):
        return canonical
    for candidate in _legacy_config_candidates(runtime_env):
        if candidate.exists():
            return candidate
    return canonical


def load_model_runtime_env(
    env: RuntimeEnv | None = None, requested_model_ref: object | None = None
) -> dict[str, str]:
    """Load user config as env-style values while real env keeps final precedence."""

    runtime_env = dict(os.environ if env is None else env)
    values = _read_model_config_env(runtime_env, requested_model_ref)
    for key, value in runtime_env.items():
        if value is not None:
            values[key] = value
    return values


def load_configured_model_catalog(
    env: RuntimeEnv | None = None,
) -> ConfiguredModelCatalog:
    """Return the secret-free provider/model catalog used by the frontend."""

    runtime_env = dict(os.environ if env is None else env)
    path = resolve_kodeks_config_path(runtime_env)
    if not path.exists():
        return _with_default_model_catalog(
            ConfiguredModelCatalog(models=[]), runtime_env
        )
    config = _resolve_config_env_vars(json.loads(path.read_text()), runtime_env)
    model = _object_value(config.get("model"))
    root_models = _object_value(config.get("models"))
    providers = _object_value(model.get("providers")) if model else None
    if providers is None:
        providers = _object_value(root_models.get("providers")) if root_models else None
    if providers is None:
        providers = {}
    models: list[ConfiguredModelOption] = []
    for provider_id, provider in providers.items():
        provider_config = _object_value(provider)
        if provider_config is None:
            continue
        models.extend(_configured_models_from_provider(provider_id, provider_config))
    primary = _string_value(model.get("primary")) if model else None
    return _with_default_model_catalog(
        ConfiguredModelCatalog(primary=primary, models=models), runtime_env
    )


def resolve_model_client_options(
    env: RuntimeEnv | None = None,
    requested_reasoning_effort: object | None = None,
    requested_provider: object | None = None,
) -> dict[str, object] | None:
    """Resolve the current model provider options without constructing a client."""

    runtime_env = dict(os.environ if env is None else env)
    _assert_no_deprecated_model_env(runtime_env)
    provider_override = _resolve_provider_override(requested_provider)
    if provider_override == "openai":
        return _resolve_openai_options(runtime_env, requested_reasoning_effort)
    if provider_override == "moonbridge":
        return _resolve_bridge_options(
            {**runtime_env, "KODEKS_MODEL_PROVIDER": "moonbridge"},
            requested_reasoning_effort,
        )
    configured_provider = _resolve_configured_provider(
        runtime_env.get("KODEKS_MODEL_PROVIDER")
    )
    if configured_provider == "openai":
        return _resolve_openai_options(runtime_env, requested_reasoning_effort)
    if configured_provider == "moonbridge":
        return _resolve_bridge_options(runtime_env, requested_reasoning_effort)
    return _resolve_bridge_options_if_configured(
        runtime_env, requested_reasoning_effort
    ) or _resolve_openai_options(runtime_env, requested_reasoning_effort)


def read_chat_completions_api_key(env: RuntimeEnv) -> str | None:
    """Read upstream Chat Completions API key, allowing local no-auth endpoints."""

    base_url = read_chat_completions_base_url(env)
    return _string_value(env.get("KODEKS_CHAT_COMPLETIONS_API_KEY")) or (
        LOCAL_ENDPOINT_API_KEY if is_local_http_url(base_url) else None
    )


def read_chat_completions_base_url(env: RuntimeEnv) -> str:
    """Read the DeepSeek-first Chat Completions base URL."""

    return (
        env.get("KODEKS_CHAT_COMPLETIONS_BASE_URL") or DEFAULT_CHAT_COMPLETIONS_BASE_URL
    )


def read_chat_completions_model(env: RuntimeEnv) -> str:
    """Read the DeepSeek-first Chat Completions model id."""

    return env.get("KODEKS_CHAT_COMPLETIONS_MODEL") or DEFAULT_DEEPSEEK_MODEL


def read_chat_completions_config(env: RuntimeEnv) -> dict[str, object]:
    """Read MoonBridge upstream config and list missing required keys."""

    api_key = read_chat_completions_api_key(env)
    base_url = read_chat_completions_base_url(env)
    model = read_chat_completions_model(env)
    missing: list[str] = []
    if not api_key:
        missing.append("KODEKS_CHAT_COMPLETIONS_API_KEY")
    if not base_url.strip():
        missing.append("KODEKS_CHAT_COMPLETIONS_BASE_URL")
    if not model.strip():
        missing.append("KODEKS_CHAT_COMPLETIONS_MODEL")
    return {"apiKey": api_key, "baseURL": base_url, "model": model, "missing": missing}


def is_local_http_url(value: str | None) -> bool:
    """Return whether a URL is a local HTTP endpoint that may omit auth."""

    if value is None:
        return False
    parsed = urlparse(value)
    return parsed.scheme == "http" and parsed.hostname in {
        "127.0.0.1",
        "localhost",
        "::1",
    }


def _read_model_config_env(
    env: RuntimeEnv, requested_model_ref: object | None
) -> dict[str, str]:
    path = resolve_kodeks_config_path(env)
    if not path.exists():
        return {}
    config = _resolve_config_env_vars(json.loads(path.read_text()), env)
    return _model_config_to_env(config, requested_model_ref)


def _model_config_to_env(
    config: Mapping[str, Any], requested_model_ref: object | None
) -> dict[str, str]:
    values: dict[str, str] = {}
    model = _object_value(config.get("model"))
    root_models = _object_value(config.get("models"))
    _write_env_section(values, _object_value(config.get("env")))
    if model is not None:
        _write_string(
            values, "KODEKS_MODEL_PROVIDER", _normalize_provider(model.get("provider"))
        )
        _write_endpoint(
            values,
            "KODEKS_RESPONSES",
            _object_value(model.get("responses")) or _object_value(model.get("openai")),
        )
        _write_endpoint(
            values,
            "KODEKS_CHAT_COMPLETIONS",
            _object_value(model.get("chatCompletions")),
        )
        _write_bridge(values, _object_value(model.get("bridge")))
        _write_selected_provider(
            values,
            model,
            _object_value(root_models.get("providers")) if root_models else None,
            requested_model_ref,
        )
    else:
        _write_selected_provider(
            values,
            None,
            _object_value(root_models.get("providers")) if root_models else None,
            requested_model_ref,
        )
    _write_embeddings(values, _object_value(config.get("embeddings")))
    return values


def _write_selected_provider(
    values: MutableMapping[str, str],
    model: Mapping[str, Any] | None,
    root_providers: Mapping[str, Any] | None,
    requested_model_ref: object | None,
) -> None:
    providers = _object_value(model.get("providers")) if model else None
    if providers is None and root_providers is not None:
        providers = dict(root_providers)
    selection = _resolve_selected_provider(model, providers, requested_model_ref)
    if selection is None:
        return
    _provider_id, provider, model_id = selection
    api = _normalize_api_shape(provider.get("api"))
    endpoint = {**provider, "model": provider.get("model") or model_id}
    if api == "responses":
        values["KODEKS_MODEL_PROVIDER"] = "openai"
        _write_endpoint(values, "KODEKS_RESPONSES", endpoint)
    if api == "chat-completions":
        values["KODEKS_MODEL_PROVIDER"] = "moonbridge"
        _write_endpoint(values, "KODEKS_CHAT_COMPLETIONS", endpoint)


def _resolve_selected_provider(
    model: Mapping[str, Any] | None,
    providers: Mapping[str, Any] | None,
    requested_model_ref: object | None,
) -> tuple[str, Mapping[str, Any], str | None] | None:
    if providers is None:
        return None
    primary = _string_value(requested_model_ref) or (
        _string_value(model.get("primary")) if model else None
    )
    from_primary = _split_model_ref(primary)
    provider_name = _string_value(model.get("provider")) if model else None
    provider_id = from_primary[0] if from_primary else provider_name
    if provider_id is None:
        return None
    provider = _object_value(providers.get(provider_id))
    if provider is None:
        return None
    model_id = (
        from_primary[1]
        if from_primary
        else _string_value(provider.get("model"))
        or _first_configured_model_id(provider)
    )
    return provider_id, provider, model_id


def _configured_models_from_provider(
    provider_id: str, provider: Mapping[str, Any]
) -> list[ConfiguredModelOption]:
    api = _normalize_api_shape(provider.get("api"))
    if api is None:
        return []
    raw_models = provider.get("models")
    explicit: list[ConfiguredModelOption] = []
    if isinstance(raw_models, list):
        for model in raw_models:
            item = _object_value(model)
            model_id = _string_value(item.get("id")) if item else None
            if model_id is None:
                continue
            explicit.append(
                _create_configured_model_option(
                    provider_id,
                    provider,
                    api,
                    model_id,
                    (_string_value(item.get("name")) if item is not None else None)
                    or model_id,
                )
            )
    fallback_model_id = _string_value(provider.get("model"))
    if explicit or fallback_model_id is None:
        return explicit
    return [
        _create_configured_model_option(
            provider_id, provider, api, fallback_model_id, fallback_model_id
        )
    ]


def _create_configured_model_option(
    provider_id: str,
    provider: Mapping[str, Any],
    api: Literal["responses", "chat-completions"],
    model_id: str,
    model_name: str,
) -> ConfiguredModelOption:
    base_url = _string_value(provider.get("baseURL"))
    api_key = _string_value(provider.get("apiKey"))
    configured = (
        base_url is not None or api_key is not None
        if api == "responses"
        else base_url is not None
        and (api_key is not None or is_local_http_url(base_url))
    )
    return ConfiguredModelOption(
        ref=f"{provider_id}/{model_id}",
        providerId=provider_id,
        providerName=provider_id,
        modelId=model_id,
        modelName=model_name,
        api=api,
        requiresBridge=api == "chat-completions",
        baseURL=base_url,
        configured=configured,
    )


def _with_default_model_catalog(
    catalog: ConfiguredModelCatalog, env: RuntimeEnv
) -> ConfiguredModelCatalog:
    default_option = ConfiguredModelOption(
        ref=DEFAULT_DEEPSEEK_MODEL_REF,
        providerId="deepseek",
        providerName="DeepSeek",
        modelId=DEFAULT_DEEPSEEK_MODEL,
        modelName=DEFAULT_DEEPSEEK_MODEL,
        api="chat-completions",
        requiresBridge=True,
        baseURL=env.get("KODEKS_CHAT_COMPLETIONS_BASE_URL")
        or DEFAULT_CHAT_COMPLETIONS_BASE_URL,
        configured=bool(env.get("KODEKS_CHAT_COMPLETIONS_API_KEY"))
        or is_local_http_url(
            env.get("KODEKS_CHAT_COMPLETIONS_BASE_URL")
            or DEFAULT_CHAT_COMPLETIONS_BASE_URL
        ),
    )
    return ConfiguredModelCatalog(
        primary=DEFAULT_DEEPSEEK_MODEL_REF,
        models=[
            default_option,
            *[
                model
                for model in catalog.models
                if model.ref != DEFAULT_DEEPSEEK_MODEL_REF
            ],
        ],
    )


def _resolve_bridge_options(
    env: RuntimeEnv, requested_reasoning_effort: object
) -> dict[str, object]:
    return {
        "provider": "moonbridge",
        "apiKey": env.get("KODEKS_BRIDGE_API_KEY") or DEFAULT_BRIDGE_API_KEY,
        "baseURL": _trim_trailing_slash(
            env.get("KODEKS_BRIDGE_BASE_URL") or DEFAULT_BRIDGE_BASE_URL
        ),
        "model": env.get("KODEKS_BRIDGE_MODEL") or DEFAULT_BRIDGE_MODEL,
        "reasoningEffort": _resolve_reasoning_effort(
            requested_reasoning_effort,
            env.get("KODEKS_BRIDGE_REASONING_EFFORT"),
            DEFAULT_BRIDGE_REASONING_EFFORT,
        ),
    }


def _resolve_bridge_options_if_configured(
    env: RuntimeEnv, requested_reasoning_effort: object
) -> dict[str, object] | None:
    return (
        _resolve_bridge_options(env, requested_reasoning_effort)
        if _should_use_bridge(env)
        else None
    )


def _resolve_openai_options(
    env: RuntimeEnv, requested_reasoning_effort: object
) -> dict[str, object] | None:
    api_key = (
        env.get("KODEKS_RESPONSES_API_KEY")
        or env.get("OPENAI_API_KEY")
        or (LOCAL_ENDPOINT_API_KEY if env.get("KODEKS_RESPONSES_BASE_URL") else None)
    )
    if not api_key:
        return None
    return {
        "provider": "openai",
        "apiKey": api_key,
        "baseURL": env.get("KODEKS_RESPONSES_BASE_URL") or env.get("OPENAI_BASE_URL"),
        "model": env.get("KODEKS_RESPONSES_MODEL")
        or env.get("OPENAI_MODEL")
        or DEFAULT_OPENAI_MODEL,
        "reasoningEffort": _resolve_reasoning_effort(
            requested_reasoning_effort,
            env.get("KODEKS_RESPONSES_REASONING_EFFORT")
            or env.get("OPENAI_REASONING_EFFORT"),
            DEFAULT_OPENAI_REASONING_EFFORT,
        ),
        "statefulResponses": env.get("KODEKS_RESPONSES_STATEFUL") == "true",
        "strictTools": env.get("KODEKS_STRICT_TOOL_SCHEMAS") == "true",
        "hostedTools": _resolve_hosted_tools(env.get("KODEKS_OPENAI_HOSTED_TOOLS")),
    }


def _should_use_bridge(env: RuntimeEnv) -> bool:
    return (
        any(
            env.get(key) is not None
            for key in [
                "KODEKS_MODEL_PROVIDER",
                "KODEKS_BRIDGE_ENABLED",
                "KODEKS_BRIDGE_API_KEY",
                "KODEKS_CHAT_COMPLETIONS_API_KEY",
                "KODEKS_CHAT_COMPLETIONS_BASE_URL",
                "KODEKS_CHAT_COMPLETIONS_MODEL",
                "KODEKS_BRIDGE_BASE_URL",
                "KODEKS_BRIDGE_MODEL",
            ]
        )
        and env.get("KODEKS_MODEL_PROVIDER") != "openai"
    )


def _resolve_provider_override(value: object) -> Literal["openai", "moonbridge"] | None:
    if value in {"openai", "moonbridge"}:
        return value  # type: ignore[return-value]
    if isinstance(value, str) and value in DEPRECATED_PROVIDER_VALUES:
        raise ModelConfigurationError(
            f'Model provider "{value}" has been removed. Use "{DEPRECATED_PROVIDER_VALUES[value]}" instead.'
        )
    return None


def _resolve_configured_provider(
    value: str | None,
) -> Literal["openai", "moonbridge"] | None:
    if not value:
        return None
    if value == "responses":
        return "openai"
    if value in {"openai", "moonbridge"}:
        return value  # type: ignore[return-value]
    if value in DEPRECATED_PROVIDER_VALUES:
        raise ModelConfigurationError(
            f'KODEKS_MODEL_PROVIDER="{value}" has been removed. Use "{DEPRECATED_PROVIDER_VALUES[value]}" instead.'
        )
    raise ModelConfigurationError(
        f'Unsupported KODEKS_MODEL_PROVIDER="{value}". Use "openai", "responses", or "moonbridge".'
    )


def _assert_no_deprecated_model_env(env: RuntimeEnv) -> None:
    for old, new in DEPRECATED_ENV_MIGRATIONS.items():
        if env.get(old) is not None:
            raise ModelConfigurationError(
                f"{old} has been removed. Rename it to {new}; Kodeks now only accepts KODEKS_* model configuration keys plus official OPENAI_* fallback keys."
            )


def _legacy_config_candidates(env: RuntimeEnv) -> list[Path]:
    system = platform.system().lower()
    if system == "darwin":
        return [
            Path.home()
            / "Library"
            / "Application Support"
            / "kodeks"
            / CONFIG_FILE_NAME
        ]
    if system == "windows":
        app_data = env.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return [Path(app_data) / "kodeks" / CONFIG_FILE_NAME]
    xdg_home = env.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return [Path(xdg_home) / "kodeks" / CONFIG_FILE_NAME]


def _resolve_config_env_vars(value: Any, env: RuntimeEnv) -> Any:
    if isinstance(value, str):
        return re.sub(
            r"\$\{([A-Z_][A-Z0-9_]*)\}",
            lambda match: env.get(match.group(1)) or match.group(0),
            value,
        )
    if isinstance(value, list):
        return [_resolve_config_env_vars(item, env) for item in value]
    if isinstance(value, dict):
        return {key: _resolve_config_env_vars(item, env) for key, item in value.items()}
    return value


def _write_endpoint(
    values: MutableMapping[str, str], prefix: str, endpoint: Mapping[str, Any] | None
) -> None:
    if endpoint is None:
        return
    _write_string(values, f"{prefix}_API_KEY", endpoint.get("apiKey"))
    _write_string(values, f"{prefix}_BASE_URL", endpoint.get("baseURL"))
    _write_string(values, f"{prefix}_MODEL", endpoint.get("model"))
    _write_string(values, f"{prefix}_REASONING_EFFORT", endpoint.get("reasoningEffort"))


def _write_bridge(
    values: MutableMapping[str, str], bridge: Mapping[str, Any] | None
) -> None:
    if bridge is None:
        return
    if isinstance(bridge.get("enabled"), bool):
        values["KODEKS_BRIDGE_ENABLED"] = str(bridge["enabled"]).lower()
    _write_endpoint(values, "KODEKS_BRIDGE", bridge)


def _write_embeddings(
    values: MutableMapping[str, str], embeddings: Mapping[str, Any] | None
) -> None:
    if embeddings is None:
        return
    if isinstance(embeddings.get("enabled"), bool):
        values["KODEKS_EMBEDDINGS_ENABLED"] = str(embeddings["enabled"]).lower()
    provider = _string_value(embeddings.get("provider")) or "openai-compatible"
    _write_string(values, "KODEKS_EMBEDDINGS_PROVIDER", provider)
    if provider in {"lmstudio", "lm-studio", "openai-compatible", "openai"}:
        _write_string(
            values, "KODEKS_OPENAI_COMPAT_BASE_URL", embeddings.get("baseURL")
        )
        _write_string(values, "KODEKS_OPENAI_COMPAT_API_KEY", embeddings.get("apiKey"))
        _write_string(
            values, "KODEKS_OPENAI_COMPAT_EMBED_MODEL", embeddings.get("model")
        )
    elif provider == "ollama":
        _write_string(values, "KODEKS_OLLAMA_BASE_URL", embeddings.get("baseURL"))
        _write_string(values, "KODEKS_OLLAMA_EMBED_MODEL", embeddings.get("model"))
    elif provider in {"huggingface", "hf"}:
        _write_string(values, "KODEKS_HUGGINGFACE_BASE_URL", embeddings.get("baseURL"))
        _write_string(values, "KODEKS_HUGGINGFACE_API_TOKEN", embeddings.get("apiKey"))
        _write_string(values, "KODEKS_HUGGINGFACE_EMBED_MODEL", embeddings.get("model"))


def _write_env_section(
    values: MutableMapping[str, str], env: Mapping[str, Any] | None
) -> None:
    if env is None:
        return
    for key, value in env.items():
        _write_string(values, key, value)


def _write_string(values: MutableMapping[str, str], key: str, value: object) -> None:
    string = _string_value(value)
    if string is not None:
        values[key] = string


def _normalize_provider(value: object) -> str | None:
    if value == "responses":
        return "openai"
    return _string_value(value)


def _normalize_api_shape(
    value: object,
) -> Literal["responses", "chat-completions"] | None:
    if value in {
        "responses",
        "openai-responses",
        "openai-codex-responses",
        "azure-openai-responses",
    }:
        return "responses"
    if value in {"chat-completions", "openai-completions", "completions"}:
        return "chat-completions"
    return None


def _resolve_reasoning_effort(
    requested: object, configured: str | None, fallback: ReasoningEffort
) -> ReasoningEffort:
    if isinstance(requested, str) and requested in SUPPORTED_REASONING_EFFORTS:
        return requested  # type: ignore[return-value]
    if configured in SUPPORTED_REASONING_EFFORTS:
        return configured  # type: ignore[return-value]
    return fallback


def _resolve_hosted_tools(value: str | None) -> list[str]:
    if value is None:
        return []
    return sorted(
        {
            item.strip()
            for item in value.split(",")
            if item.strip() == "web_search_preview"
        }
    )


def _split_model_ref(value: str | None) -> tuple[str, str] | None:
    if value is None or "/" not in value:
        return None
    provider, model = value.split("/", 1)
    return (provider, model) if provider and model else None


def _first_configured_model_id(provider: Mapping[str, Any]) -> str | None:
    models = provider.get("models")
    if not isinstance(models, list) or not models:
        return None
    first = _object_value(models[0])
    return _string_value(first.get("id")) if first else None


def _object_value(value: object) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _string_value(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _trim_trailing_slash(value: str) -> str:
    return value[:-1] if value.endswith("/") else value
