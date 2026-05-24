# q1: 为什么 workspace root 和 runtime state 都放在 config 层？
# a1: 这些是全局运行边界，服务层和 runtime 层都要依赖；集中定义能避免各模块自己猜项目路径。
# q2: 这和 /src、opencode 的设计参考有什么关系？
# a2: 两个参考项目都把项目/session/workspace 视为 agent 的核心上下文。kodeks 先用最小配置表达这些边界，后续再扩展成更完整的 project/session metadata。

from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
WORKSPACE_ROOT = PROJECT_ROOT
RUNTIME_STATE_DIR = PROJECT_ROOT / ".kodeks"
SESSION_STATE_DB_PATH = RUNTIME_STATE_DIR / "session_state.sqlite3"
TOOL_AUDIT_LOG_PATH = RUNTIME_STATE_DIR / "tool_audit.jsonl"
MEMORY_LOG_PATH = RUNTIME_STATE_DIR / "memory.jsonl"
SUBAGENT_LOG_PATH = RUNTIME_STATE_DIR / "subagents.jsonl"
