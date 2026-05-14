from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[3]
WORKSPACE_ROOT = PROJECT_ROOT
RUNTIME_STATE_DIR = PROJECT_ROOT / ".kodeks"
SESSION_STATE_DB_PATH = RUNTIME_STATE_DIR / "session_state.sqlite3"
