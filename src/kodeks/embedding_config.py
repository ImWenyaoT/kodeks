"""Embeddings configuration interpretation for Kodeks."""

from __future__ import annotations

from collections.abc import Mapping, MutableMapping
from typing import Any


def write_embeddings_config(
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


def _write_string(values: MutableMapping[str, str], key: str, value: object) -> None:
    """Write a non-empty string value into the env map."""

    string = _string_value(value)
    if string is not None:
        values[key] = string


def _string_value(value: object) -> str | None:
    """Return a stripped non-empty string or None."""

    return value.strip() if isinstance(value, str) and value.strip() else None
