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
DOTENV_FILE_NAME = ".env"
MODEL_ENV_ALIASES = {
    "API_KEY": "KODEKS_CHAT_COMPLETIONS_API_KEY",
    "DEEPSEEK_API_KEY": "KODEKS_CHAT_COMPLETIONS_API_KEY",
    "BASE_URL": "KODEKS_CHAT_COMPLETIONS_BASE_URL",
    "DEEPSEEK_BASE_URL": "KODEKS_CHAT_COMPLETIONS_BASE_URL",
    "MODEL": "KODEKS_CHAT_COMPLETIONS_MODEL",
    "DEEPSEEK_MODEL": "KODEKS_CHAT_COMPLETIONS_MODEL",
}

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
    "resolve_kodeks_dotenv_path",
    "resolve_kodeks_config_dir",
    "resolve_kodeks_config_path",
    "resolve_kodeks_workspace_config_dir",
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
    """Resolve the Kodeks config path across explicit, workspace, and user scopes."""

    runtime_env = os.environ if env is None else env
    override = _string_value(runtime_env.get("KODEKS_CONFIG_PATH"))
    if override is not None:
        return Path(override).expanduser().resolve()
    config_dir_override = _string_value(runtime_env.get("KODEKS_CONFIG_DIR"))
    user_config = resolve_kodeks_config_dir(runtime_env) / CONFIG_FILE_NAME
    if config_dir_override is not None:
        return user_config
    workspace_config = resolve_kodeks_workspace_config_dir(runtime_env) / CONFIG_FILE_NAME
    if workspace_config.exists():
        return workspace_config
    if user_config.exists():
        return user_config
    for candidate in _legacy_config_candidates(runtime_env):
        if candidate.exists():
            return candidate
    return user_config


def resolve_kodeks_workspace_config_dir(env: RuntimeEnv | None = None) -> Path:
    """Resolve the workspace-level Kodeks config directory."""

    runtime_env = os.environ if env is None else env
    workspace_root = _string_value(runtime_env.get("KODEKS_WORKSPACE_ROOT"))
    root = Path(workspace_root).expanduser() if workspace_root is not None else Path.cwd()
    return root.resolve() / CONFIG_DIR_NAME


def resolve_kodeks_dotenv_path(env: RuntimeEnv | None = None) -> Path:
    """Resolve the project-local `.env` path."""

    runtime_env = os.environ if env is None else env
    workspace_root = _string_value(runtime_env.get("KODEKS_WORKSPACE_ROOT"))
    root = Path(workspace_root).expanduser() if workspace_root is not None else Path.cwd()
    return root.resolve() / DOTENV_FILE_NAME


def load_model_runtime_env(
    env: RuntimeEnv | None = None, requested_model_ref: object | None = None
) -> dict[str, str]:
    """Load config files as env-style values while process env keeps precedence."""

    runtime_env = _load_dotenv_runtime_env(os.environ if env is None else env)
    values = _read_model_config_env(runtime_env, requested_model_ref)
    for key, value in runtime_env.items():
        if value is not None:
            values[key] = value
    _apply_requested_deepseek_model(values, requested_model_ref)
    return values


def load_configured_model_catalog(
    env: RuntimeEnv | None = None,
) -> ConfiguredModelCatalog:
    """Return the secret-free DeepSeek model catalog used by the frontend."""

    runtime_env = _load_dotenv_runtime_env(os.environ if env is None else env)
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

    runtime_env = _load_dotenv_runtime_env(os.environ if env is None else env)
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


def _apply_requested_deepseek_model(
    values: dict[str, str], requested_model_ref: object | None
) -> None:
    """Apply a requested `deepseek/<model>` ref to env-only configuration."""

    requested = _split_deepseek_model_ref(_string_value(requested_model_ref))
    if requested is None:
        return
    values["KODEKS_MODEL_PROVIDER"] = "moonbridge"
    values["KODEKS_CHAT_COMPLETIONS_MODEL"] = requested


def _split_deepseek_model_ref(value: str | None) -> str | None:
    """Return the model id from a DeepSeek model ref."""

    if value is None or "/" not in value:
        return None
    provider, model = value.split("/", 1)
    return model if provider == "deepseek" and model else None


def _load_dotenv_runtime_env(env: RuntimeEnv) -> dict[str, str | None]:
    """Merge project-local `.env` values without overriding explicit env."""

    values = _normalize_model_env_aliases(dict(env))
    if env is not os.environ and "KODEKS_WORKSPACE_ROOT" not in values:
        return values
    path = resolve_kodeks_dotenv_path(values)
    if not path.exists():
        return values
    dotenv_values = _normalize_model_env_aliases(_read_dotenv_file(path))
    merged: dict[str, str | None] = dict(dotenv_values)
    merged.update(values)
    return merged


def _normalize_model_env_aliases(
    env: Mapping[str, str | None],
) -> dict[str, str | None]:
    """Copy friendly model env aliases into the canonical runtime names."""

    normalized = dict(env)
    for alias, canonical in MODEL_ENV_ALIASES.items():
        if _string_value(normalized.get(canonical)) is None:
            alias_value = _string_value(normalized.get(alias))
            if alias_value is not None:
                normalized[canonical] = alias_value
    return normalized


def _read_dotenv_file(path: Path) -> dict[str, str]:
    """Read simple dotenv assignments from a UTF-8 file."""

    values: dict[str, str] = {}
    for raw_line in path.read_text().splitlines():
        parsed = _parse_dotenv_line(raw_line)
        if parsed is None:
            continue
        key, value = parsed
        values[key] = value
    return values


def _parse_dotenv_line(line: str) -> tuple[str, str] | None:
    """Parse one dotenv line into a key/value pair when possible."""

    stripped = line.strip()
    if not stripped or stripped.startswith("#"):
        return None
    if stripped.startswith("export "):
        stripped = stripped[7:].lstrip()
    key, separator, raw_value = stripped.partition("=")
    if not separator:
        return None
    key = key.strip()
    if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        return None
    return key, _parse_dotenv_value(raw_value.strip())


def _parse_dotenv_value(value: str) -> str:
    """Parse a dotenv value with lightweight quote and comment handling."""

    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value.split(" #", 1)[0].strip()


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
