import json
import tomllib
from pathlib import Path

from fastapi.testclient import TestClient

from kodeks.app import create_app
from kodeks.config import DEFAULT_DEEPSEEK_MODEL
from kodeks.providers.bridge import to_deepseek_chat_request
from kodeks.tools.schemas import default_tool_definitions

REPO_ROOT = Path(__file__).resolve().parents[1]


def test_python_package_declares_harness_identity():
    """Package metadata and entrypoints describe the Kodeks harness."""

    pyproject = tomllib.loads((REPO_ROOT / "pyproject.toml").read_text())

    assert "coding agent harness" in pyproject["project"]["description"]
    assert pyproject["project"]["scripts"] == {
        "kodeks-server": "kodeks.server:main",
        "kodeks-smoke": "kodeks.smoke:main",
    }
    assert pyproject["build-system"] == {
        "requires": [],
        "build-backend": "kodeks_build",
        "backend-path": ["build_backend"],
    }
    assert (REPO_ROOT / "build_backend/kodeks_build.py").exists()
    assert (REPO_ROOT / "src/kodeks/static/index.html").exists()
    assert pyproject["tool"]["mypy"]["files"] == ["src/kodeks", "build_backend"]


def test_root_agents_instructions_are_not_part_of_repository():
    """Repository-local agent instructions are outside the runtime tree."""

    assert not (REPO_ROOT / "AGENTS.md").exists()


def test_fastapi_route_surface_matches_harness_boundary():
    """FastAPI exposes the local coding-agent harness routes."""

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


def test_ci_runs_python_harness_validation_and_smoke():
    """CI includes the validation gates for the harness runtime."""

    ci = (REPO_ROOT / ".github/workflows/ci.yml").read_text()

    assert "uv sync" in ci
    assert "uv run mypy" in ci
    assert "uv run ruff check" in ci
    assert "uv run pytest" in ci
    assert "uv run python -m kodeks.smoke --in-process" in ci
    assert "uv build" in ci


def test_uv_lock_tracks_runtime_dependency_graph():
    """The lockfile includes the runtime and dev validation dependencies."""

    lock = tomllib.loads((REPO_ROOT / "uv.lock").read_text())
    packages = {package["name"]: package for package in lock["package"]}

    assert lock["requires-python"] == ">=3.11"
    assert packages["kodeks"]["source"] == {"editable": "."}
    assert {dependency["name"] for dependency in packages["kodeks"]["dependencies"]} >= {
        "fastapi",
        "httpx2",
        "openai",
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


def test_refactor_boundary_docs_require_validation_and_six_dimensions():
    """Refactor docs keep validation tied to the six harness dimensions."""

    checklist = (REPO_ROOT / "docs/refactor-parity.md").read_text()

    for dimension in [
        "状态管理",
        "流程控制",
        "人工审批",
        "可观测性",
        "多 Agent",
        "协议集成",
    ]:
        assert dimension in checklist
    assert "uv run pytest" in checklist
    assert "uv run ruff check" in checklist
    assert "uv run mypy" in checklist
    assert "uv build" in checklist
    assert "focused pytest files" in checklist


def test_readme_navigation_centers_current_boundary_docs():
    """README navigation points to current product and harness docs."""

    readme = (REPO_ROOT / "README.md").read_text()
    readme_zh = (REPO_ROOT / "README.zh-CN.md").read_text()

    assert "[Architecture](./docs/architecture.md)" in readme
    assert "[Product requirements](./docs/PRD.md)" in readme
    assert "[Concept map](./docs/concepts-map.md)" in readme
    assert "[架构说明](./docs/architecture.md)" in readme_zh
    assert "[产品需求](./docs/PRD.md)" in readme_zh
    assert "[概念映射](./docs/concepts-map.md)" in readme_zh
    assert "./docs/superpowers/" not in readme
    assert "./docs/superpowers/" not in readme_zh


def test_readme_quickstart_uses_python_runtime_commands():
    """README examples point users at the local FastAPI runtime and health route."""

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
        assert "localhost:3000" not in content


def test_prd_defines_minimal_harness_boundary():
    """PRD uses the six harness dimensions as the product standard."""

    prd = (REPO_ROOT / "docs/PRD.md").read_text()

    assert "带 memory、multi-session、subagent、plan mode 的 coding agent" in prd
    for dimension in [
        "状态管理",
        "流程控制",
        "人工审批",
        "可观测性",
        "多 Agent",
        "协议集成",
    ]:
        assert dimension in prd
    assert "web search tools" in prd
    assert "provider dashboard" in prd
    assert "通用多 Agent 编排平台" in prd


def test_concepts_map_links_dimensions_to_assets_and_evals():
    """Concepts map is organized by harness dimensions."""

    concepts = (REPO_ROOT / "docs/concepts-map.md").read_text()

    for asset in [
        "src/kodeks/runtime.py",
        "src/kodeks/responses_runtime.py",
        "src/kodeks/workspace.py",
        "src/kodeks/providers/bridge.py",
        "evals/run_local.py",
    ]:
        assert asset in concepts
    for dimension in [
        "状态管理",
        "流程控制",
        "人工审批",
        "可观测性",
        "多 Agent",
        "协议集成",
    ]:
        assert dimension in concepts


def test_models_route_keeps_secret_free_deepseek_contract(tmp_path, monkeypatch):
    """The `/api/models` route returns only DeepSeek metadata without secrets."""

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
                        "deepseek": {
                            "api": "chat-completions",
                            "baseURL": "https://api.deepseek.com",
                            "apiKey": "deepseek-secret",
                            "models": [{"id": "deepseek-v4-pro", "name": "DeepSeek V4 Pro"}],
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
    ]
    assert "local-secret" not in response.text
    assert "deepseek-secret" not in response.text
    assert body["models"][0]["requiresBridge"] is True


def test_bridge_preflight_keeps_moonbridge_implicit_for_deepseek(
    tmp_path, monkeypatch
):
    """DeepSeek resolves to MoonBridge without exposing adapter controls."""

    async def fake_reachable(_base_url):
        """Return a deterministic successful upstream probe for contract tests."""

        return None

    config_path = tmp_path / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "model": {
                    "primary": "deepseek/deepseek-v4-pro",
                    "providers": {
                        "deepseek": {
                            "api": "chat-completions",
                            "baseURL": "https://api.deepseek.com",
                            "apiKey": "deepseek-placeholder",
                            "models": [{"id": "deepseek-v4-pro"}],
                        }
                    },
                }
            }
        )
    )
    monkeypatch.setenv("KODEKS_CONFIG_PATH", str(config_path))
    monkeypatch.setattr("kodeks.app._check_chat_completions_upstream", fake_reachable)
    client = TestClient(create_app())

    response = client.post(
        "/api/bridge/preflight", json={"model": "deepseek/deepseek-v4-pro"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ready"
    assert body["provider"] == "auto"
    assert body["resolvedProvider"] == "moonbridge"
    assert body["upstreamBaseURL"] == "https://api.deepseek.com"
    assert body["upstreamModel"] == "deepseek-v4-pro"


def test_chat_routes_emit_config_errors_without_side_effects(tmp_path, monkeypatch):
    """Chat routes expose missing model configuration as runtime events."""

    monkeypatch.setenv("KODEKS_DB_PATH", str(tmp_path / "kodeks.sqlite3"))
    monkeypatch.setenv("KODEKS_CONFIG_PATH", str(tmp_path / "missing.json"))
    for key in [
        "KODEKS_CHAT_COMPLETIONS_API_KEY",
        "KODEKS_CHAT_COMPLETIONS_BASE_URL",
        "KODEKS_CHAT_COMPLETIONS_MODEL",
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
    """Tool schemas keep the model-facing names and order stable."""

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
