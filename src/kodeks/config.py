"""Runtime configuration file loading for the Python Kodeks service."""

from __future__ import annotations

import json
import os
import platform
import re
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from .contracts import ConfiguredModelCatalog
from .model_config import (
    DEFAULT_DEEPSEEK_MODEL,
    configured_deepseek_models,
    is_local_http_url,
    model_config_to_env,
    read_chat_completions_api_key,
    read_chat_completions_base_url,
    read_chat_completions_config,
    read_chat_completions_model,
    resolve_model_client_options_from_env,
    with_default_model_catalog,
)
from .model_config import ModelConfigurationError as ModelConfigurationError

RuntimeEnv = Mapping[str, str | None]

CONFIG_FILE_NAME = "config.json"
CONFIG_DIR_NAME = ".kodeks"

__all__ = [
    "DEFAULT_DEEPSEEK_MODEL",
    "ModelConfigurationError",
    "is_local_http_url",
    "load_configured_model_catalog",
    "load_model_runtime_env",
    "read_chat_completions_api_key",
    "read_chat_completions_base_url",
    "read_chat_completions_config",
    "read_chat_completions_model",
    "resolve_kodeks_config_dir",
    "resolve_kodeks_config_path",
    "resolve_model_client_options",
]


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
    """Return the secret-free DeepSeek model catalog used by the frontend."""

    runtime_env = dict(os.environ if env is None else env)
    path = resolve_kodeks_config_path(runtime_env)
    if not path.exists():
        return with_default_model_catalog(
            ConfiguredModelCatalog(models=[]), runtime_env
        )
    config = _resolve_config_env_vars(json.loads(path.read_text()), runtime_env)
    return with_default_model_catalog(
        ConfiguredModelCatalog(models=configured_deepseek_models(config)),
        runtime_env,
    )


def resolve_model_client_options(
    env: RuntimeEnv | None = None,
    requested_reasoning_effort: object | None = None,
    requested_provider: object | None = None,
) -> dict[str, object] | None:
    """Resolve the current model provider options without constructing a client."""

    runtime_env = dict(os.environ if env is None else env)
    return resolve_model_client_options_from_env(
        runtime_env,
        requested_reasoning_effort=requested_reasoning_effort,
        requested_provider=requested_provider,
    )


def _read_model_config_env(
    env: RuntimeEnv, requested_model_ref: object | None
) -> dict[str, str]:
    path = resolve_kodeks_config_path(env)
    if not path.exists():
        return {}
    config = _resolve_config_env_vars(json.loads(path.read_text()), env)
    return model_config_to_env(config, requested_model_ref)


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


def _string_value(value: object) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None
