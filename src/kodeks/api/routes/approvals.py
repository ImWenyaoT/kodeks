# q1: approval route 解决的是什么产品问题？
# a1: Phase 5B 只能把危险 shell 暂停成 pending approval；Phase 6 要给人类一个明确入口，决定批准执行还是拒绝执行。
# q2: 为什么 route 只调用 service，不直接读写 JSONL 或执行 shell？
# a2: HTTP 是传输层，approval 状态机和恢复执行属于 service 层。保持这个边界后，未来 CLI/TUI 也能复用同一套 approval service。

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from kodeks.services.audit_service import (
    ApprovalAlreadyResolvedError,
    ApprovalExecutionTimeoutError,
    ApprovalNotFoundError,
    approve_approval,
    get_approval_status,
    reject_approval,
)

router = APIRouter(prefix="/api/approvals", tags=["approvals"])


class RejectApprovalRequest(BaseModel):
    """Request body for rejecting a pending approval."""

    reason: str | None = None


@router.get("/{approval_id}")
async def read_approval(approval_id: str) -> dict[str, object]:
    """Return the latest status for one approval id."""

    try:
        return await asyncio.to_thread(get_approval_status, approval_id)
    except ApprovalNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Approval not found") from exc


@router.post("/{approval_id}/approve")
async def approve_shell_command(approval_id: str) -> dict[str, object]:
    """Approve a pending shell command and execute it once."""

    try:
        return await asyncio.to_thread(approve_approval, approval_id)
    except ApprovalNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Approval not found") from exc
    except ApprovalAlreadyResolvedError as exc:
        raise HTTPException(status_code=409, detail="Approval is already resolved") from exc
    except ApprovalExecutionTimeoutError as exc:
        raise HTTPException(status_code=408, detail="Approved command timed out") from exc


@router.post("/{approval_id}/reject")
async def reject_shell_command(
    approval_id: str,
    request: RejectApprovalRequest,
) -> dict[str, object]:
    """Reject a pending shell command without executing it."""

    try:
        return await asyncio.to_thread(reject_approval, approval_id, reason=request.reason)
    except ApprovalNotFoundError as exc:
        raise HTTPException(status_code=404, detail="Approval not found") from exc
    except ApprovalAlreadyResolvedError as exc:
        raise HTTPException(status_code=409, detail="Approval is already resolved") from exc
