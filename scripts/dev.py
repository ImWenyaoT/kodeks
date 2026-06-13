# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""双进程开发编排：同时拉起 Python FastAPI 后端（uvicorn :8000）与 Next.js 前端（:3000）。

用法（仓库根目录）：
    uv run scripts/dev.py

行为：
- 后端：`uv run kodeks-server --reload --host 127.0.0.1 --port 8000`
- 前端：`npm run dev`（cwd=frontend，监听 :3000，经 rewrites 反代 /api -> :8000）
- 任一子进程退出即整体收尾；Ctrl-C 传播到两者，统一退出。
不新增 .sh：用本 PEP723 uv-script 编排（遵守仓库工具链规则），跨平台。
"""

from __future__ import annotations

import subprocess
import sys
import threading
import time
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FRONTEND_DIR = REPO_ROOT / "frontend"

# 子进程定义：(标签, 命令, cwd)。
PROCESSES: list[tuple[str, list[str], Path]] = [
    (
        "backend",
        ["uv", "run", "kodeks-server", "--reload", "--host", "127.0.0.1", "--port", "8000"],
        REPO_ROOT,
    ),
    ("frontend", ["npm", "run", "dev"], FRONTEND_DIR),
]


def _stream_output(label: str, proc: subprocess.Popen[str]) -> None:
    """逐行打印子进程输出并打上标签前缀，便于在单终端区分两进程日志。"""

    assert proc.stdout is not None
    for line in proc.stdout:
        sys.stdout.write(f"[{label}] {line}")
        sys.stdout.flush()


def _terminate_all(procs: list[tuple[str, subprocess.Popen[str]]]) -> None:
    """向所有仍存活的子进程发送终止信号，做优雅收尾。"""

    for _label, proc in procs:
        if proc.poll() is None:
            proc.terminate()


def main() -> int:
    """启动两个子进程，转发日志；任一退出或 Ctrl-C 时终止全部并返回退出码。"""

    procs: list[tuple[str, subprocess.Popen[str]]] = []
    for label, cmd, cwd in PROCESSES:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        procs.append((label, proc))
        threading.Thread(target=_stream_output, args=(label, proc), daemon=True).start()

    exit_code = 0
    try:
        # 轮询直到任一子进程退出（time.sleep 跨平台，避免 signal.pause 的平台差异）。
        while True:
            for label, proc in procs:
                code = proc.poll()
                if code is not None:
                    sys.stdout.write(f"[dev] {label} 退出（code={code}），收尾其余进程。\n")
                    exit_code = code or 0
                    raise SystemExit
            time.sleep(0.5)
    except (KeyboardInterrupt, SystemExit):
        pass
    finally:
        _terminate_all(procs)
        for _label, proc in procs:
            proc.wait()
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
