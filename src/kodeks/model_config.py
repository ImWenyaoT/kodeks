"""Model and embeddings configuration interpretation for Kodeks."""

from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from typing import Any, Literal
from urllib.parse import urlparse

from .contracts import ConfiguredModelCatalog, ConfiguredModelOption, ReasoningEffort

RuntimeEnv = Mapping[str, str | None]

DEFAULT_CHAT_COMPLETIONS_BASE_URL = "https://api.deepseek.com"
DEFAULT_DEEPSEEK_MODEL = "deepseek-v4-pro"
DEFAULT_DEEPSEEK_MODEL_REF = f"deepseek/{DEFAULT_DEEPSEEK_MODEL}"
DEFAULT_BRIDGE_API_KEY = "bridge"
DEFAULT_BRIDGE_BASE_URL = "http://127.0.0.1:38440/v1"
DEFAULT_BRIDGE_MODEL = "bridge"
DEFAULT_BRIDGE_REASONING_EFFORT: ReasoningEffort = "high"
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


def model_config_to_env(
    config: Mapping[str, Any], requested_model_ref: object | None
) -> dict[str, str]:
    """Expand user model config into the env-style runtime contract."""

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
            "KODEKS_CHAT_COMPLETIONS",
            _object_value(model.get("chatCompletions")),
        )
        _write_bridge(values, _object_value(model.get("bridge")))
    _write_deepseek_provider(
        values,
        model,
        _object_value(root_models.get("providers")) if root_models else None,
        requested_model_ref,
    )
    _write_embeddings(values, _object_value(config.get("embeddings")))
    return values


def configured_deepseek_models(
    config: Mapping[str, Any]
) -> list[ConfiguredModelOption]:
    """Read configured DeepSeek model options and ignore other provider entries."""

    model = _object_value(config.get("model"))
    provider = _find_deepseek_provider(model, _object_value(config.get("models")))
    if provider is None:
        provider = _object_value(model.get("chatCompletions")) if model else None
    if provider is None:
        return []
    return _configured_models_from_deepseek_provider(provider)


def with_default_model_catalog(
    catalog: ConfiguredModelCatalog, env: RuntimeEnv
) -> ConfiguredModelCatalog:
    """Add the default DeepSeek option and keep the catalog secret-free."""

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


def resolve_model_client_options_from_env(
    env: RuntimeEnv,
    requested_reasoning_effort: object | None = None,
    requested_provider: object | None = None,
) -> dict[str, object] | None:
    """Resolve provider client options from the env-style runtime contract."""

    _assert_no_deprecated_model_env(env)
    provider_override = _resolve_provider_override(requested_provider)
    if provider_override == "moonbridge":
        return _resolve_bridge_options(
            {**env, "KODEKS_MODEL_PROVIDER": "moonbridge"},
            requested_reasoning_effort,
        )
    configured_provider = _resolve_configured_provider(env.get("KODEKS_MODEL_PROVIDER"))
    if configured_provider == "moonbridge":
        return _resolve_bridge_options(env, requested_reasoning_effort)
    return _resolve_bridge_options_if_configured(env, requested_reasoning_effort)


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


def _write_deepseek_provider(
    values: MutableMapping[str, str],
    model: Mapping[str, Any] | None,
    root_providers: Mapping[str, Any] | None,
    requested_model_ref: object | None,
) -> None:
    """Expand only the DeepSeek provider registry entry into runtime env."""

    provider = _find_deepseek_provider(model, root_providers)
    if provider is None:
        return
    requested = _split_model_ref(_string_value(requested_model_ref))
    if requested is not None and requested[0] != "deepseek":
        return
    model_id = (
        requested[1]
        if requested is not None
        else _string_value(provider.get("model"))
        or _first_configured_model_id(provider)
        or DEFAULT_DEEPSEEK_MODEL
    )
    endpoint = {**provider, "model": provider.get("model") or model_id}
    values["KODEKS_MODEL_PROVIDER"] = "moonbridge"
    _write_endpoint(values, "KODEKS_CHAT_COMPLETIONS", endpoint)


def _find_deepseek_provider(
    model: Mapping[str, Any] | None,
    root_models_or_providers: Mapping[str, Any] | None,
) -> dict[str, Any] | None:
    """Find the supported DeepSeek provider entry from model or root config."""

    providers = _object_value(model.get("providers")) if model else None
    if providers is None and root_models_or_providers is not None:
        providers = (
            _object_value(root_models_or_providers.get("providers"))
            or dict(root_models_or_providers)
        )
    return _object_value(providers.get("deepseek")) if providers else None


def _configured_models_from_deepseek_provider(
    provider: Mapping[str, Any]
) -> list[ConfiguredModelOption]:
    """Convert one DeepSeek provider entry into frontend model options."""

    api = _normalize_api_shape(provider.get("api"))
    if api not in {None, "chat-completions"}:
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
                    provider,
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
            provider, fallback_model_id, fallback_model_id
        )
    ]


def _create_configured_model_option(
    provider: Mapping[str, Any],
    model_id: str,
    model_name: str,
) -> ConfiguredModelOption:
    """Create the secret-free frontend model option for one model id."""

    base_url = _string_value(provider.get("baseURL"))
    api_key = _string_value(provider.get("apiKey"))
    configured = base_url is not None and (
        api_key is not None or is_local_http_url(base_url)
    )
    return ConfiguredModelOption(
        ref=f"deepseek/{model_id}",
        providerId="deepseek",
        providerName="DeepSeek",
        modelId=model_id,
        modelName=model_name,
        api="chat-completions",
        requiresBridge=True,
        baseURL=base_url,
        configured=configured,
    )


def _resolve_bridge_options(
    env: RuntimeEnv, requested_reasoning_effort: object
) -> dict[str, object]:
    """Build MoonBridge client options from env-style values."""

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
    """Return bridge options only when the env asks for model routing."""

    return (
        _resolve_bridge_options(env, requested_reasoning_effort)
        if _should_use_bridge(env)
        else None
    )


def _should_use_bridge(env: RuntimeEnv) -> bool:
    """Return whether any model-routing key is configured."""

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
    )


def _resolve_provider_override(value: object) -> Literal["moonbridge"] | None:
    """Validate an explicit provider override."""

    if value == "moonbridge":
        return "moonbridge"
    if value in {"openai", "responses"}:
        raise ModelConfigurationError(
            "Direct OpenAI/Responses model providers have been removed. Configure DeepSeek Chat Completions instead."
        )
    if isinstance(value, str) and value in DEPRECATED_PROVIDER_VALUES:
        raise ModelConfigurationError(
            f'Model provider "{value}" has been removed. Use "{DEPRECATED_PROVIDER_VALUES[value]}" instead.'
        )
    return None


def _resolve_configured_provider(
    value: str | None,
) -> Literal["moonbridge"] | None:
    """Validate the configured provider value."""

    if not value:
        return None
    if value == "moonbridge":
        return "moonbridge"
    if value in {"openai", "responses"}:
        raise ModelConfigurationError(
            "Direct OpenAI/Responses model providers have been removed. Configure DeepSeek Chat Completions instead."
        )
    if value in DEPRECATED_PROVIDER_VALUES:
        raise ModelConfigurationError(
            f'KODEKS_MODEL_PROVIDER="{value}" has been removed. Use "{DEPRECATED_PROVIDER_VALUES[value]}" instead.'
        )
    raise ModelConfigurationError(
        f'Unsupported KODEKS_MODEL_PROVIDER="{value}". Use "moonbridge" for the DeepSeek Chat Completions route.'
    )


def _assert_no_deprecated_model_env(env: RuntimeEnv) -> None:
    """Fail fast when old model env aliases are still present."""

    for old, new in DEPRECATED_ENV_MIGRATIONS.items():
        if env.get(old) is not None:
            raise ModelConfigurationError(
                f"{old} has been removed. Rename it to {new}; Kodeks now only accepts DeepSeek/MoonBridge KODEKS_* model configuration keys."
            )


def _write_endpoint(
    values: MutableMapping[str, str], prefix: str, endpoint: Mapping[str, Any] | None
) -> None:
    """Write a config endpoint object to prefixed env-style keys."""

    if endpoint is None:
        return
    _write_string(values, f"{prefix}_API_KEY", endpoint.get("apiKey"))
    _write_string(values, f"{prefix}_BASE_URL", endpoint.get("baseURL"))
    _write_string(values, f"{prefix}_MODEL", endpoint.get("model"))
    _write_string(values, f"{prefix}_REASONING_EFFORT", endpoint.get("reasoningEffort"))


def _write_bridge(
    values: MutableMapping[str, str], bridge: Mapping[str, Any] | None
) -> None:
    """Write bridge config to env-style values."""

    if bridge is None:
        return
    if isinstance(bridge.get("enabled"), bool):
        values["KODEKS_BRIDGE_ENABLED"] = str(bridge["enabled"]).lower()
    _write_endpoint(values, "KODEKS_BRIDGE", bridge)


def _write_embeddings(
    values: MutableMapping[str, str], embeddings: Mapping[str, Any] | None
) -> None:
    """Write embedding provider config to env-style values."""

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
    """Copy explicit config env entries into env-style values."""

    if env is None:
        return
    for key, value in env.items():
        _write_string(values, key, value)


def _write_string(values: MutableMapping[str, str], key: str, value: object) -> None:
    """Write a non-empty string value into the env map."""

    string = _string_value(value)
    if string is not None:
        values[key] = string


def _normalize_provider(value: object) -> str | None:
    """Normalize old config provider labels that point at MoonBridge."""

    if value in {"deepseek", "chat-completions"}:
        return "moonbridge"
    return _string_value(value)


def _normalize_api_shape(
    value: object,
) -> Literal["responses", "chat-completions"] | None:
    """Normalize supported model API shape aliases."""

    if value in {
        "chat-completions",
        "openai-completions",
        "completions",
        "deepseek",
    }:
        return "chat-completions"
    return None


def _resolve_reasoning_effort(
    requested: object, configured: str | None, fallback: ReasoningEffort
) -> ReasoningEffort:
    """Resolve the requested reasoning effort with config and default precedence."""

    if isinstance(requested, str) and requested in SUPPORTED_REASONING_EFFORTS:
        return requested  # type: ignore[return-value]
    if configured in SUPPORTED_REASONING_EFFORTS:
        return configured  # type: ignore[return-value]
    return fallback


def _split_model_ref(value: str | None) -> tuple[str, str] | None:
    """Split a provider/model ref into provider and model id."""

    if value is None or "/" not in value:
        return None
    provider, model = value.split("/", 1)
    return (provider, model) if provider and model else None


def _first_configured_model_id(provider: Mapping[str, Any]) -> str | None:
    """Read the first explicit model id from a provider config."""

    models = provider.get("models")
    if not isinstance(models, list) or not models:
        return None
    first = _object_value(models[0])
    return _string_value(first.get("id")) if first else None


def _object_value(value: object) -> dict[str, Any] | None:
    """Return a dict config value or None."""

    return value if isinstance(value, dict) else None


def _string_value(value: object) -> str | None:
    """Return a stripped non-empty string or None."""

    return value.strip() if isinstance(value, str) and value.strip() else None


def _trim_trailing_slash(value: str) -> str:
    """Trim one trailing slash from a URL-like value."""

    return value[:-1] if value.endswith("/") else value
