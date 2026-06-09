// frontend/app/api/bridge/preflight/route.ts
// POST /api/bridge/preflight —— 薄包装：MoonBridge 就绪诊断（始终 200 body）。
import { NextResponse } from 'next/server'
import { bridgePreflight, readJsonBody, requireControlRequest } from '@/lib/server/routes'
import type { RuntimeEnv } from '@/lib/server/config'

export const runtime = 'nodejs'

/** 报告 MoonBridge 就绪诊断。 */
export async function POST(request: Request): Promise<NextResponse> {
  const denied = requireControlRequest(request)
  if (denied !== null) {
    return denied
  }
  const body = await readJsonBody(request)
  return bridgePreflight({ body, env: process.env as RuntimeEnv })
}
