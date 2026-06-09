// frontend/lib/server/routes/control.ts
// 控制面 API gate：本地开发允许 localhost；非本地必须显式配置并提供控制 token。
import { NextResponse } from 'next/server'

export const CONTROL_TOKEN_COOKIE = 'kodeks_control_token'

/**
 * 校验控制面请求的 origin 与 token；返回 null 表示允许，NextResponse 表示拒绝。
 */
export function requireControlRequest(
  request: Request,
  env: Record<string, string | undefined> = process.env,
): NextResponse | null {
  const requestUrl = new URL(request.url)
  if (!hasSameOriginBoundary(request, requestUrl)) {
    return NextResponse.json({ detail: 'Cross-origin control request denied.' }, { status: 403 })
  }

  const expectedToken = env.KODEKS_CONTROL_TOKEN?.trim()
  if (expectedToken) {
    const suppliedToken = controlTokenFromRequest(request)
    if (suppliedToken !== expectedToken) {
      return NextResponse.json({ detail: 'Control token is required.' }, { status: 401 })
    }
    return null
  }

  if (isLocalHostname(requestUrl.hostname)) {
    return null
  }
  return NextResponse.json(
    { detail: 'KODEKS_CONTROL_TOKEN is required for non-local control API.' },
    { status: 503 },
  )
}

/** 同源 Origin/Referer 检查；缺失时交给 token/localhost 边界处理。 */
function hasSameOriginBoundary(request: Request, requestUrl: URL): boolean {
  const origin = request.headers.get('origin')
  if (origin && safeOrigin(origin) !== requestUrl.origin) {
    return false
  }
  const referer = request.headers.get('referer')
  if (referer && safeOrigin(referer) !== requestUrl.origin) {
    return false
  }
  return true
}

/** 从 Authorization / x-kodeks-control-token / cookie 读取控制 token。 */
function controlTokenFromRequest(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (authorization?.startsWith('Bearer ')) {
    return authorization.slice('Bearer '.length).trim()
  }
  const headerToken = request.headers.get('x-kodeks-control-token')?.trim()
  if (headerToken) {
    return headerToken
  }
  return cookieValue(request.headers.get('cookie'), CONTROL_TOKEN_COOKIE)
}

/** 解析一个 cookie 值；不做 URL 解码以保持 token 字面匹配。 */
function cookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) {
    return null
  }
  for (const part of cookieHeader.split(';')) {
    const [rawName, ...rest] = part.trim().split('=')
    if (rawName === name) {
      return rest.join('=')
    }
  }
  return null
}

/** 安全读取 URL origin；非法 URL 直接判为不同源。 */
function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

/** 本地开发 hostname 白名单。 */
function isLocalHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost')
}
