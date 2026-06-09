// frontend/app/health/route.ts
// GET /health —— 薄包装：就绪状态（{ok:true, runtime:'typescript'}）。
import { NextResponse } from 'next/server'
import { health } from '@/lib/server/routes'

export const runtime = 'nodejs'

/** 返回部署管理器与本地冒烟检查使用的就绪状态。 */
export function GET(): NextResponse {
  return health()
}
