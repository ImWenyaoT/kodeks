# q1: shell route 在产品上暴露的是什么能力？
# a1: 它把“运行项目命令并返回结构化结果”做成稳定 API，后续可以复用为模型 tool。
# q2: route 层为什么要把超时转成 HTTP 408？
# a2: 调用方需要区分“命令执行失败”和“命令卡死超时”，这样 agent loop 才能做不同决策。
# q3: 为什么 shell route 不等于 shell tool？
# a3: route 只暴露开发期 API；真正进入 agent tool loop 前，要按 /src 优先、opencode 对照的方式补 approval、审计和更强 command policy。

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from kodeks.services.shell_service import ShellCommandTimeoutError, run_command

router = APIRouter(prefix="/api/shell", tags=["shell"])


class RunShellRequest(BaseModel):
    command: str


@router.post("/run")
async def run_shell_command(request: RunShellRequest) -> dict[str, object]:
    """Run a shell command in the workspace."""
    try:
        result = await asyncio.to_thread(run_command, request.command)
    except ShellCommandTimeoutError as exc:
        raise HTTPException(status_code=408, detail="Command timed out") from exc

    return {
        "command": result.command,
        "exit_code": result.exit_code,
        "stdout": result.stdout,
        "stderr": result.stderr,
        "approval_required": result.approval_required,
        "stdout_truncated": result.stdout_truncated,
        "stderr_truncated": result.stderr_truncated,
    }
