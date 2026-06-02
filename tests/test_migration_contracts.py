import json
import tomllib
from pathlib import Path

from fastapi.testclient import TestClient

from kodeks.app import create_app
from kodeks.bridge import to_deepseek_chat_request
from kodeks.config import DEFAULT_DEEPSEEK_MODEL
from kodeks.tools import default_tool_definitions

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_workspace_no_longer_contains_typescript_runtime_surface():
    """The migration contract keeps the active workspace Python-only."""

    forbidden_paths = [
        "apps/web",
        "packages",
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
        "eslint.config.mjs",
        "tsconfig.base.json",
        ".prettierrc.json",
        ".prettierignore",
    ]

    for relative_path in forbidden_paths:
        assert not (REPO_ROOT / relative_path).exists(), relative_path

    typescript_sources = [
        path
        for path in REPO_ROOT.rglob("*")
        if path.suffix in {".ts", ".tsx"}
        and ".git" not in path.parts
        and ".venv" not in path.parts
    ]

    assert typescript_sources == []


def test_python_package_includes_static_ui_assets():
    """Python packaging keeps the browser shell after removing Next.js."""

    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())

    assert pyproject["project"]["scripts"] == {
        "kodeks-server": "kodeks.server:main",
        "kodeks-smoke": "kodeks.smoke:main",
    }
    assert (REPO_ROOT / "src/kodeks/static/index.html").exists()


def test_agents_instructions_are_python_runtime_aligned():
    """Repository agent instructions no longer point contributors at pnpm."""

    instructions = (REPO_ROOT / "AGENTS.md").read_text()

    assert "Use `uv run`" in instructions
    assert "full Python gate" in instructions
    assert "do not reintroduce TypeScript SDK packages" in instructions
    assert "pnpm" not in instructions
    assert "Next.js routes" in instructions


def test_python_package_build_backend_is_declared():
    """Python packaging uses the offline in-tree build backend."""

    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())

    assert pyproject["build-system"] == {
        "requires": [],
        "build-backend": "kodeks_build",
        "backend-path": ["build_backend"],
    }
    assert (REPO_ROOT / "build_backend/kodeks_build.py").exists()
    assert pyproject["tool"]["mypy"]["files"] == ["src/kodeks", "build_backend"]


def test_python_fastapi_route_surface_matches_migration_inventory():
    """FastAPI exposes the Python replacement routes and bridge aliases."""

    route_surface = {
        (method, route.path)
        for route in create_app().routes
        for method in getattr(route, "methods", set())
    }

    expected_routes = {
        ("GET", "/"),
        ("GET", "/health"),
        ("GET", "/api/models"),
        ("GET", "/api/sessions"),
        ("POST", "/api/sessions"),
        ("GET", "/api/sessions/{session_id}"),
        ("GET", "/api/workspace/files"),
        ("GET", "/api/approvals/{approval_id}"),
        ("POST", "/api/approvals/{approval_id}"),
        ("POST", "/api/bridge/preflight"),
        ("GET", "/bridge/health"),
        ("GET", "/v1/models"),
        ("GET", "/models"),
        ("POST", "/v1/responses"),
        ("POST", "/responses"),
        ("POST", "/api/chat/stream"),
        ("POST", "/api/chat/ui"),
    }
    assert expected_routes <= route_surface


def test_ci_runs_python_validation_and_in_process_smoke():
    """CI no longer depends on Node and includes Python smoke validation."""

    ci = (REPO_ROOT / ".github/workflows/ci.yml").read_text()

    assert "actions/setup-node" not in ci
    assert "pnpm" not in ci
    assert "uv sync" in ci
    assert "uv run mypy" in ci
    assert "uv run ruff check" in ci
    assert "uv run pytest" in ci
    assert "uv run python -m kodeks.smoke --in-process" in ci
    assert "uv build" in ci


def test_uv_lock_tracks_python_only_dependency_graph():
    """The lockfile reflects the Python runtime and no Node toolchain packages."""

    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text())
    packages = {package["name"]: package for package in lock["package"]}

    assert lock["requires-python"] == ">=3.11"
    assert packages["kodeks"]["source"] == {"editable": "."}
    assert {dependency["name"] for dependency in packages["kodeks"]["dependencies"]} >= {
        "fastapi",
        "httpx",
        "httpx2",
        "openai",
        "openai-agents",
        "pydantic",
        "uvicorn",
    }
    assert {
        dependency["name"]
        for dependency in packages["kodeks"]["dev-dependencies"]["dev"]
    } >= {"mypy", "pytest", "pytest-asyncio", "ruff"}
    assert {
        dependency["name"]
        for dependency in packages["kodeks"]["metadata"]["requires-dev"]["dev"]
    } >= {"mypy", "pytest", "pytest-asyncio", "ruff"}
    for forbidden in [
        "typescript",
        "next",
        "react",
        "eslint",
        "vitest",
        "prettier",
        "pnpm",
    ]:
        assert forbidden not in packages


def test_refactor_parity_docs_require_python_validation_and_build():
    """Migration docs keep Python validation gates current."""

    checklist = (REPO_ROOT / "docs/refactor-parity.md").read_text()

    assert "uv run pytest" in checklist
    assert "uv run ruff check" in checklist
    assert "uv run mypy" in checklist
    assert "uv build" in checklist
    assert "focused pytest files" in checklist
    assert "route parity checks" in checklist
    assert "build isolation" not in checklist
    assert "package tests" not in checklist


def test_readme_marks_superseded_typescript_design_as_historical():
    """README navigation points to current migration docs before history."""

    readme = (REPO_ROOT / "README.md").read_text()
    readme_zh = (REPO_ROOT / "README.zh-CN.md").read_text()

    assert "Modernization plan" in readme
    assert "Historical TS design" in readme
    assert "Migration design" not in readme
    assert "现代化计划" in readme_zh
    assert "历史 TS 设计" in readme_zh
    assert "迁移设计" not in readme_zh


def test_superseded_typescript_design_stays_archival_only():
    """The historical design doc cannot become an active TS migration guide again."""

    design = (
        REPO_ROOT / "docs/superpowers/specs/2026-05-24-ts-agents-migration-design.md"
    ).read_text()

    assert "Superseded archival note" in design
    assert "Do not use this archived note to recreate TypeScript SDK packages" in design
    assert "docs/MODERNIZATION.md" in design
    assert "src/kodeks/*" in design
    assert "not an active migration plan" in design
    for forbidden in [
        "## Chosen Stack",
        "## Package Layout",
        "Next.js App Router",
        "OpenAI JS SDK",
        "The migrated project should be strong enough",
        "implementation remains Next.js",
    ]:
        assert forbidden not in design


def test_readme_quickstart_uses_python_runtime_commands():
    """README examples point users at the Python runtime and health route."""

    readme = (REPO_ROOT / "README.md").read_text()
    readme_zh = (REPO_ROOT / "README.zh-CN.md").read_text()

    for content in [readme, readme_zh]:
        assert "uv sync" in content
        assert "uv run kodeks-server --reload" in content
        assert "http://127.0.0.1:8000/health" in content
        assert "http://127.0.0.1:8000/api/chat/stream" in content
        assert "uv run pytest" in content
        assert "uv run ruff check" in content
        assert "uv run mypy" in content
        assert "uv build" in content
        assert "uv run python -m kodeks.smoke --in-process" in content
        assert "no-side-effect `/api/chat/stream` validation" in content or (
            "无副作用 `/api/chat/stream` validation" in content
        )
        assert "KODEKS_OPENAI_COMPAT_BASE_URL" in content
        assert "KODEKS_OPENAI_COMPAT_EMBED_MODEL" in content
        assert "pnpm install" not in content
        assert "pnpm run" not in content
        assert "localhost:3000" not in content
        assert "KODEKS_LMSTUDIO_BASE_URL" not in content
        assert "KODEKS_LMSTUDIO_EMBED_MODEL" not in content


def test_modernization_plan_covers_required_migration_surfaces():
    """Migration plan documents the requested surfaces, gates, and fallback."""

    modernization = (REPO_ROOT / "docs/MODERNIZATION.md").read_text()

    for surface in [
        "Routing",
        "Data models",
        "Auth and safety",
        "Configuration",
        "Build tooling",
        "Tests",
        "Deployment/runtime",
        "External contracts",
    ]:
        assert f"| {surface}" in modernization
    assert "## Milestones" in modernization
    assert "Rollback is the last TS-backed branch/release" in modernization
    assert "Cut the Python agent loop over by default" in modernization
    assert "KODEKS_DIRECT_RESPONSES_RUNTIME=true" in modernization
    assert "behind a feature flag" not in modernization
    assert "no-side-effect chat route validation" in modernization
    assert "no-side-effect `/api/chat/stream` validation" in modernization
    assert "live provider smoke success" in modernization
    assert "local sockets are allowed" in modernization
    for command in [
        "uv run pytest",
        "uv run ruff check",
        "uv run mypy",
        "uv run python -m kodeks.smoke --in-process",
        "uv build",
    ]:
        assert command in modernization


def test_prd_marks_reference_paths_as_non_active_surface():
    """PRD reference paths must not reopen the TypeScript implementation target."""

    prd = (REPO_ROOT / "docs/PRD.md").read_text()

    assert "不是当前 Kodeks 的 active implementation surface" in prd
    assert "`src/kodeks/*` 的 Python runtime 模块为准" in prd
    assert "不要把参考项目里的 TypeScript 路径当成" in prd


def test_models_route_keeps_secret_free_provider_model_contract(tmp_path, monkeypatch):
    """The Python `/api/models` route returns selector metadata without secrets."""

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
                            "apiKey": "local-secret",
                            "models": [{"id": "qwen3.6", "name": "Qwen 3.6"}],
                        },
                        "openai": {
                            "api": "responses",
                            "apiKey": "sk-secret",
                            "models": [{"id": "gpt-5.4-mini"}],
                        },
                    },
                }
            }
        )
    )
    monkeypatch.setenv("KODEKS_CONFIG_PATH", str(config_path))
    client = TestClient(create_app())

    response = client.get("/api/models")

    assert response.status_code == 200
    body = response.json()
    assert body["primary"] == f"deepseek/{DEFAULT_DEEPSEEK_MODEL}"
    refs = [model["ref"] for model in body["models"]]
    assert refs == [
        f"deepseek/{DEFAULT_DEEPSEEK_MODEL}",
        "qwen/qwen3.6",
        "openai/gpt-5.4-mini",
    ]
    assert "local-secret" not in response.text
    assert "sk-secret" not in response.text
    assert body["models"][1]["requiresBridge"] is True
    assert body["models"][2]["requiresBridge"] is False


def test_bridge_preflight_keeps_moonbridge_implicit_for_chat_completions(
    tmp_path, monkeypatch
):
    """Chat-Completions providers resolve to MoonBridge without UI provider leakage."""

    async def fake_reachable(_base_url):
        """Return a deterministic successful upstream probe for contract tests."""

        return None

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
                            "models": [{"id": "qwen3.6"}],
                        }
                    },
                }
            }
        )
    )
    monkeypatch.setenv("KODEKS_CONFIG_PATH", str(config_path))
    monkeypatch.setattr("kodeks.app._check_chat_completions_upstream", fake_reachable)
    client = TestClient(create_app())

    response = client.post("/api/bridge/preflight", json={"model": "qwen/qwen3.6"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["provider"] == "auto"
    assert body["resolvedProvider"] == "moonbridge"
    assert body["upstreamBaseURL"] == "http://127.0.0.1:8010/v1"
    assert body["upstreamModel"] == "qwen3.6"


def test_python_chat_routes_keep_feature_flag_error_path(tmp_path, monkeypatch):
    """Chat routes keep rollback visible through config errors until cutover."""

    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))
    monkeypatch.setenv("KODEKS_CONFIG_PATH", str(tmp_path / "missing.json"))
    for key in [
        "KODEKS_CHAT_COMPLETIONS_API_KEY",
        "KODEKS_CHAT_COMPLETIONS_BASE_URL",
        "KODEKS_CHAT_COMPLETIONS_MODEL",
        "KODEKS_RESPONSES_API_KEY",
        "KODEKS_RESPONSES_BASE_URL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
    ]:
        monkeypatch.delenv(key, raising=False)
    client = TestClient(create_app())

    chat = client.post(
        "/api/chat/stream", json={"session_id": "sess_contract", "input": "hello"}
    )
    ui = client.post(
        "/api/chat/ui", json={"session_id": "sess_contract_ui", "input": "hello"}
    )

    assert chat.status_code == 200
    assert ui.status_code == 200
    assert "event: error" in chat.text
    assert "model_provider_missing" in chat.text
    assert "event: error" in ui.text
    assert "model_provider_missing" in ui.text


def test_tool_definition_order_matches_runtime_contract():
    """Python tool schemas keep the model-facing names and order used by TS."""

    assert [tool["name"] for tool in default_tool_definitions()] == [
        "read_file",
        "write_file",
        "grep",
        "run_shell",
        "remember_fact",
        "recall_memory",
        "read_memory_artifact",
        "spawn_explore_agent",
        "list_mcp_servers",
        "list_skills",
        "read_skill",
    ]


def test_bridge_request_keeps_responses_to_chat_contract_for_replay_items():
    """Function-call replay items map back to assistant and tool messages."""

    payload = to_deepseek_chat_request(
        {
            "input": [
                {
                    "type": "function_call",
                    "call_id": "call_read",
                    "name": "read_file",
                    "arguments": '{"path":"README.md"}',
                    "reasoning_content": "private trace",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_read",
                    "output": "contents",
                },
            ],
            "tools": [],
            "reasoning": {"effort": "high"},
        },
        model="deepseek-v4-pro",
    )

    assert payload["messages"] == [
        {
            "role": "assistant",
            "content": "",
            "reasoning_content": "private trace",
            "tool_calls": [
                {
                    "id": "call_read",
                    "type": "function",
                    "function": {
                        "name": "read_file",
                        "arguments": '{"path":"README.md"}',
                    },
                }
            ],
        },
        {
            "role": "tool",
            "content": "contents",
            "tool_call_id": "call_read",
        },
    ]
    assert payload["thinking"] == {"type": "enabled"}
    assert payload["reasoning_effort"] == "high"
