// frontend/app/api/models/route.ts
// GET /api/models —— 薄包装：返回无密钥模型目录（by_alias + exclude_none）。
import { NextResponse } from 'next/server'
import { modelsCatalog } from '@/lib/server/routes'
import type { RuntimeEnv } from '@/lib/server/config'

export const runtime = 'nodejs'

/** 返回配置好的模型目录。 */
export function GET(): NextResponse {
  return modelsCatalog(process.env as RuntimeEnv)
}
