// frontend/app/api/approvals/[id]/route.ts
// GET /api/approvals/{id}（读取）+ POST /api/approvals/{id}（决策）—— 薄包装。
import { NextResponse } from 'next/server'
import {
  decideApproval,
  getApproval,
  getDatabase,
  readJsonBody,
  requireControlRequest,
  resolveWorkspaceRoot,
} from '@/lib/server/routes'

export const runtime = 'nodejs'

/** 读取一条审批记录。 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  const { id } = await params
  const database = await getDatabase()
  return getApproval(id, database)
}

/** 决策一条审批（approve/reject），approve 时执行 shell 一次。 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  const { id } = await params
  const body = await readJsonBody(request)
  const database = await getDatabase()
  return decideApproval(id, body, database, resolveWorkspaceRoot())
}
