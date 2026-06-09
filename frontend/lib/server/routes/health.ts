// frontend/lib/server/routes/health.ts
// Health 路由逻辑（移植 health，app.py:84-88）。
// 注：Python runtime 字面量是 'python'；TS 端按裁定改为 'typescript'。
import { NextResponse } from 'next/server'

/**
 * 返回部署管理器与本地冒烟检查使用的就绪状态（移植 health，app.py:84-88）。
 * @returns 200 `{ok: true, runtime: 'typescript'}`。
 */
export function health(): NextResponse {
  return NextResponse.json({ ok: true, runtime: 'typescript' })
}
