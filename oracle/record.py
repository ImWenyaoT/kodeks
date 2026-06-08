"""Oracle 黄金 transcript 录制器（M0 行为基准）。

把 bench.py 的"假模型驱动真实 agent 循环"机制，从"渲染 HTML"改造成"录制 JSON 黄金 fixtures"。
对每个场景，用脚本化的假模型驱动【真实的】`run_python_chat_turn`，收集它吐出的全部 runtime 事件，
再分别过两条生产线缝编码器（`sse_frame` 原始 / `to_ui_transport_payload`+`sse_frame` UI），
落盘为跨语言共享的黄金数据，供 TS 端（M4/M5）逐事件 diff。

跑法（从仓库根目录）：
    UV_LINK_MODE=copy uv run --no-sync python -m oracle.record

注意：本脚本只读真实运行时 + 写 oracle/ 下的黄金数据，全程不联网、不调 DeepSeek。
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import tempfile
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from kodeks.api.sse import sse_frame
from kodeks.api.ui_transport import to_ui_transport_payload
from kodeks.runtime import run_python_chat_turn
from kodeks.storage import KodeksDatabase

ORACLE_ROOT = Path(__file__).resolve().parent
SCENARIOS_DIR = ORACLE_ROOT / "scenarios"

# 录制时需归一化（掩码）的 volatile 字段路径：生成 id（uuid）与时间戳（now）。
# TS 端对拍时对两侧施加同样归一化后做结构深比较。
VOLATILE_FIELD_PATHS = [
    "approval_required.approval_id",
    "memory_recalled.memory_ids",
    "plan_artifact.plan.id",
    "plan_artifact.plan.createdAt",
    "plan_artifact.plan.updatedAt",
    "plan_artifact.plan.sourceMessageId",
]


# ── 脚本化假模型工厂（与 tests/test_runtime.py 逐字对齐，锚定到已通过的测试）──────────────


def _has_function_call_output(body: Mapping[str, Any]) -> bool:
    """判断 replay body 是否已含工具输出项（即'模型拿到结果后的那一轮'）。"""

    replay_input = body.get("input")
    return isinstance(replay_input, list) and any(
        isinstance(item, dict) and item.get("type") == "function_call_output"
        for item in replay_input
    )


def _text_only_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """单轮纯文本：吐两段文字后宣布完成。"""

    return [
        {"type": "response.output_text.delta", "delta": "你好，"},
        {"type": "response.output_text.delta", "delta": "world。"},
        {"type": "response.completed", "response": {"id": "resp_text", "status": "completed"}},
    ]


def _single_tool_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """第一轮请求 read_file，第二轮拿到工具输出后给最终答复。"""

    if _has_function_call_output(body):
        return [
            {"type": "response.output_text.delta", "delta": "Done."},
            {"type": "response.completed", "response": {"id": "resp_final", "status": "completed"}},
        ]
    return [
        {"type": "response.output_text.delta", "delta": "Reading..."},
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_read",
                "name": "read_file",
                "arguments": json.dumps({"path": "README.md"}),
            },
        },
        {"type": "response.completed", "response": {"id": "resp_tool", "status": "completed"}},
    ]


def _unknown_tool_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """请求一个未注册工具，验证本地运行时报错并终止。"""

    return [
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_glob",
                "name": "glob",
                "arguments": json.dumps({"pattern": "**/*.ts"}),
            },
        },
        {"type": "response.completed", "response": {"id": "resp_unknown", "status": "completed"}},
    ]


def _approval_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """请求危险 shell 命令，验证本轮暂停等审批（不发 response_completed）。"""

    return [
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_shell",
                "name": "run_shell",
                "arguments": json.dumps({"command": "rm -rf output"}),
            },
        },
        {"type": "response.completed", "response": {"id": "resp_approval", "status": "completed"}},
    ]


def _plan_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """plan 模式单轮文本，收尾时落地 plan_artifact(created)。"""

    return [
        {
            "type": "response.output_text.delta",
            "delta": "# Storage plan\n\nPersist a plan artifact.\n\n1. Add a plans table\n2. Restore it next turn",
        },
        {"type": "response.completed", "response": {"id": "resp_plan", "status": "completed"}},
    ]


def _stream_error_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """模型流直接发 error 事件，验证终止性 runtime 错误。"""

    return [{"type": "error", "message": "upstream stream error"}]


def _large_tool_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """请求读大文件，工具输出被压缩为 memory artifact 引用后收尾。"""

    if _has_function_call_output(body):
        return [
            {"type": "response.completed", "response": {"id": "resp_large", "status": "completed"}},
        ]
    return [
        {
            "type": "response.output_item.done",
            "item": {
                "type": "function_call",
                "call_id": "call_large",
                "name": "read_file",
                "arguments": json.dumps({"path": "large.txt"}),
            },
        },
        {"type": "response.completed", "response": {"id": "resp_large", "status": "completed"}},
    ]


def _memory_recall_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """预置记忆命中后的单轮文本回复（场景在 setup 里预置记忆）。"""

    return [
        {"type": "response.output_text.delta", "delta": "Plan mode is read-only."},
        {"type": "response.completed", "response": {"id": "resp_memory", "status": "completed"}},
    ]


def _count_function_call_outputs(body: Mapping[str, Any]) -> int:
    """统计 replay body 里已有多少个工具输出项（判断当前是第几轮 continuation）。"""

    items = body.get("input")
    if not isinstance(items, list):
        return 0
    return sum(
        1
        for item in items
        if isinstance(item, dict) and item.get("type") == "function_call_output"
    )


def _multi_tool_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """连续两轮工具调用后再终结，验证多轮 continuation 与 append_tool_continuation_messages。"""

    count = _count_function_call_outputs(body)
    if count == 0:
        return [
            {"type": "response.output_text.delta", "delta": "Reading the first file..."},
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "call_id": "call_a",
                    "name": "read_file",
                    "arguments": json.dumps({"path": "README.md"}),
                },
            },
            {"type": "response.completed", "response": {"id": "resp_multi_1", "status": "completed"}},
        ]
    if count == 1:
        return [
            {
                "type": "response.output_item.done",
                "item": {
                    "type": "function_call",
                    "call_id": "call_b",
                    "name": "read_file",
                    "arguments": json.dumps({"path": "AGENTS.md"}),
                },
            },
            {"type": "response.completed", "response": {"id": "resp_multi_2", "status": "completed"}},
        ]
    return [
        {"type": "response.output_text.delta", "delta": "Read both files."},
        {"type": "response.completed", "response": {"id": "resp_multi_final", "status": "completed"}},
    ]


def _pseudo_tool_call_events(body: Mapping[str, Any], env: Mapping[str, str | None]) -> list[dict[str, Any]]:
    """模型把工具调用当文本吐出（含 <tool_call），验证 model_returned_pseudo_tool_call 错误。"""

    return [
        {"type": "response.output_text.delta", "delta": 'Sure: <tool_call>{"name":"x"}</tool_call>'},
        {"type": "response.completed", "response": {"id": "resp_pseudo", "status": "completed"}},
    ]


# ── 场景定义 ────────────────────────────────────────────────────────────────


@dataclass
class Scenario:
    """一个 oracle 场景：脚本化假模型 + 请求体 + workspace/db 预置 + 录制 env。"""

    id: str
    factory: Callable[[Mapping[str, Any], Mapping[str, str | None]], list[dict[str, Any]]]
    body: dict[str, Any]
    env: dict[str, str | None] = field(default_factory=dict)
    workspace_files: dict[str, str] = field(default_factory=dict)
    seed: Callable[[KodeksDatabase], None] | None = None


def _seed_memory(database: KodeksDatabase) -> None:
    """为 memory-recall 场景预置一条项目记忆。"""

    database.memories.remember(
        "project", "Kodeks uses plan mode for read-only planning.", "sess_memory"
    )


SCENARIOS: list[Scenario] = [
    Scenario(
        id="text-only",
        factory=_text_only_events,
        body={"input": "say hello", "session_id": "sess_text"},
    ),
    Scenario(
        id="single-tool",
        factory=_single_tool_events,
        body={"input": "read it", "session_id": "sess_tool"},
        workspace_files={"README.md": "hello from workspace\n"},
    ),
    Scenario(
        id="unknown-tool",
        factory=_unknown_tool_events,
        body={"input": "find files", "session_id": "sess_unknown"},
    ),
    Scenario(
        id="approval",
        factory=_approval_events,
        body={"input": "clean output", "session_id": "sess_approval"},
    ),
    Scenario(
        id="plan-mode",
        factory=_plan_events,
        body={"input": "make a plan", "session_id": "sess_plan", "mode": "plan"},
    ),
    Scenario(
        id="memory-recall",
        factory=_memory_recall_events,
        body={"input": "how should plan mode work?", "session_id": "sess_memory"},
        seed=_seed_memory,
    ),
    Scenario(
        id="stream-error",
        factory=_stream_error_events,
        body={"input": "hello", "session_id": "sess_error"},
    ),
    Scenario(
        id="large-tool",
        factory=_large_tool_events,
        body={"input": "read the large file", "session_id": "sess_large"},
        env={"KODEKS_MEMORY_ARTIFACT_THRESHOLD_BYTES": "64"},
        workspace_files={"large.txt": "memory artifact body " * 80},
    ),
    Scenario(
        id="multi-tool",
        factory=_multi_tool_events,
        body={"input": "read both files", "session_id": "sess_multi"},
        workspace_files={"README.md": "first file\n", "AGENTS.md": "second file\n"},
    ),
    Scenario(
        id="pseudo-tool-call",
        factory=_pseudo_tool_call_events,
        body={"input": "do something", "session_id": "sess_pseudo"},
    ),
]


# ── 录制核心 ────────────────────────────────────────────────────────────────


async def record_scenario(scenario: Scenario) -> dict[str, Any]:
    """录制单个场景：驱动真实循环，收集事件与两条线缝，落盘并返回摘要。"""

    workspace = Path(tempfile.mkdtemp(prefix=f"oracle-{scenario.id}-"))
    for rel_path, content in scenario.workspace_files.items():
        target = workspace / rel_path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)

    # 包裹假模型工厂，捕获每一轮（continuation）返回的脚本事件，供 TS 端按调用顺序重放。
    script_rounds: list[list[dict[str, Any]]] = []

    def capturing_factory(
        body: Mapping[str, Any], env: Mapping[str, str | None]
    ) -> list[dict[str, Any]]:
        produced = scenario.factory(body, env)
        script_rounds.append(json.loads(json.dumps(produced)))
        return produced

    database = KodeksDatabase(":memory:")
    runtime_events: list[dict[str, Any]] = []
    try:
        if scenario.seed is not None:
            scenario.seed(database)
        async for event in run_python_chat_turn(
            scenario.body, database, str(workspace), scenario.env, capturing_factory
        ):
            runtime_events.append(event)
        audit_rows = [
            {"event_type": row["event_type"], "payload": json.loads(row["payload_json"])}
            for row in database.connection.execute(
                "SELECT event_type, payload_json FROM audit_log ORDER BY rowid ASC"
            ).fetchall()
        ]
    finally:
        database.close()

    # 两条生产线缝编码（与 chat_routes.py 完全相同的调用）。
    runtime_sse = "".join(sse_frame(str(e["type"]), e) for e in runtime_events)
    ui_frames: list[str] = []
    for event in runtime_events:
        payload = to_ui_transport_payload(event)
        if payload is not None:
            ui_frames.append(sse_frame(str(payload["type"]), payload))
    ui_sse = "".join(ui_frames)

    out_dir = SCENARIOS_DIR / scenario.id
    out_dir.mkdir(parents=True, exist_ok=True)
    _write_json(out_dir / "script.json", script_rounds)
    _write_json(out_dir / "request.json", scenario.body)
    _write_json(out_dir / "runtime-events.json", runtime_events)
    _write_json(out_dir / "audit.json", audit_rows)
    (out_dir / "runtime.sse").write_text(runtime_sse, encoding="utf-8")
    (out_dir / "ui.sse").write_text(ui_sse, encoding="utf-8")

    return {
        "id": scenario.id,
        "rounds": len(script_rounds),
        "runtimeEvents": len(runtime_events),
        "uiFrames": len(ui_frames),
        "eventTypes": [e["type"] for e in runtime_events],
    }


def _write_json(path: Path, value: Any) -> None:
    """以可读缩进写 JSON（结构化 oracle，比对前会先解析，故格式不影响保真）。"""

    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _git_commit() -> str:
    """读取当前 git commit（录制溯源用，失败返回 unknown）。"""

    try:
        return subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ORACLE_ROOT.parent, text=True
        ).strip()
    except (subprocess.CalledProcessError, OSError):
        return "unknown"


async def main() -> None:
    """录制全部场景并写 manifest。"""

    SCENARIOS_DIR.mkdir(parents=True, exist_ok=True)
    summaries = [await record_scenario(scenario) for scenario in SCENARIOS]
    manifest = {
        "schemaVersion": 1,
        "recordedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        "pythonCommit": _git_commit(),
        "volatileFieldPaths": VOLATILE_FIELD_PATHS,
        "scenarios": summaries,
    }
    _write_json(SCENARIOS_DIR.parent / "manifest.json", manifest)
    print(f"✅ 录制完成 {len(summaries)} 个场景 → {SCENARIOS_DIR}")
    for summary in summaries:
        print(f"   · {summary['id']:14s} {summary['runtimeEvents']:2d} 事件  {summary['eventTypes']}")


if __name__ == "__main__":
    asyncio.run(main())
