// frontend/app/api/workspace/files/route.ts
// GET /api/workspace/files —— 薄包装。
import { NextResponse } from 'next/server'
import { filesList, requireControlRequest, resolveWorkspaceRoot } from '@/lib/server/routes'

export const runtime = 'nodejs'

/** 列出工作区可见文件（limit=500）。 */
export function GET(request: Request): NextResponse {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  return filesList(resolveWorkspaceRoot())
}
