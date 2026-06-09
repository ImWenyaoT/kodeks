// frontend/lib/server/routes/approvals.ts
// Approval 路由逻辑（移植 approval_routes.py）：读取 + 决策（reject / approve / invalid）。
// 错误 envelope 三形态严格区分（保真风险 2）：
//  · HTTPException 类（NotFound 404 / AlreadyResolved 409 / Timeout 408）→ {detail}。
//  · approval invalid/malformed → {error: '...'}（400）。
// approve 副作用顺序固定（保真风险 7, 15）：approve → runApprovedCommand → markExecuted → audit。
import { NextResponse } from 'next/server'
import {
  ApprovalAlreadyResolvedError,
  ApprovalNotFoundError,
  type KodeksDatabase,
} from '../storage'
import { runApprovedCommand, ShellCommandTimeoutError } from '../workspace'
import { type Executor } from '../execution'
import { resolveExecutor } from './deps'

/** 返回 strip 后的非空字符串，否则 null（移植 _string，approval_routes.py:104-107）。 */
function string(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  return null
}

/**
 * 从审批记录读取可执行命令（移植 _approved_command，approval_routes.py:94-101）。
 * value 须为 dict，取 value.command 为非空 str 并 strip()，否则 null。
 */
function approvedCommand(value: unknown): string | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const command = (value as Record<string, unknown>).command
    if (typeof command === 'string' && command.trim().length > 0) {
      return command.trim()
    }
  }
  return null
}

/**
 * 读取一条审批记录（移植 get_approval，approval_routes.py:25-33）。
 * 200 {approval}；ApprovalNotFoundError → 404 {detail: str(exc)}。
 */
export async function getApproval(
  approvalId: string,
  database: KodeksDatabase,
): Promise<NextResponse> {
  try {
    const approval = await database.approvals.getApproval(approvalId)
    return NextResponse.json({ approval })
  } catch (error) {
    if (error instanceof ApprovalNotFoundError) {
      return NextResponse.json({ detail: error.message }, { status: 404 })
    }
    throw error
  }
}

/**
 * 决策一条审批（移植 decide_approval，approval_routes.py:35-91）。
 * reject → reject + audit approval_rejected + 200 {approval}；
 * decision !== 'approve'（且非 reject）→ 400 {error:'Invalid decision. Expected "approve" or "reject".'}；
 * approve → 取 pending；无可执行命令 → 400 {error:'Approval does not contain an executable command.'}；
 *   否则 approve → runApprovedCommand(workspaceRoot) → markExecuted → audit approval_executed → 200 {approval, result}。
 * 异常映射：NotFound 404 / AlreadyResolved 409 / ShellCommandTimeout 408（均 {detail}）。
 * @param executor 命令执行后端（M6 可注入）；默认 resolveExecutor()——本地 LocalExecutor、
 *   Vercel 上配齐 sandbox 鉴权时 SandboxExecutor。透传给 runApprovedCommand 实现透明替换。
 */
export async function decideApproval(
  approvalId: string,
  body: Record<string, unknown>,
  database: KodeksDatabase,
  workspaceRoot: string,
  executor: Executor = resolveExecutor(),
): Promise<NextResponse> {
  const decision = body.decision
  try {
    if (decision === 'reject') {
      const approval = await database.approvals.reject(
        approvalId,
        string(body.reason) ?? 'Rejected by user',
      )
      await database.auditLog.record(approval.sessionId, 'approval_rejected', {
        approvalId: approval.id,
      })
      return NextResponse.json({ approval })
    }
    if (decision !== 'approve') {
      return NextResponse.json(
        { error: 'Invalid decision. Expected "approve" or "reject".' },
        { status: 400 },
      )
    }
    const pending = await database.approvals.getApproval(approvalId)
    const command = approvedCommand(pending.command)
    if (command === null) {
      return NextResponse.json(
        { error: 'Approval does not contain an executable command.' },
        { status: 400 },
      )
    }
    const approved = await database.approvals.approve(approvalId)
    // 透传 executor：本地默认 LocalExecutor；Vercel 上为 SandboxExecutor。runApprovedCommand 的
    // 后三个形参（timeoutMs/maxOutputBytes/parseFailureMessage）保持默认，仅末位 executor 注入。
    const result = await runApprovedCommand(
      command,
      workspaceRoot,
      undefined,
      undefined,
      undefined,
      executor,
    )
    const executed = await database.approvals.markExecuted(approvalId)
    await database.auditLog.record(approved.sessionId, 'approval_executed', {
      approvalId: approved.id,
      command,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    })
    return NextResponse.json({ approval: executed, result: result.toWire() })
  } catch (error) {
    if (error instanceof ApprovalNotFoundError) {
      return NextResponse.json({ detail: error.message }, { status: 404 })
    }
    if (error instanceof ApprovalAlreadyResolvedError) {
      return NextResponse.json({ detail: error.message }, { status: 409 })
    }
    if (error instanceof ShellCommandTimeoutError) {
      return NextResponse.json({ detail: error.message }, { status: 408 })
    }
    throw error
  }
}
