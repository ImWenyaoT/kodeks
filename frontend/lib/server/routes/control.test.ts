import { describe, expect, it } from 'vitest'
import { requireControlRequest } from './control'

/** 构造带可控 URL/header 的 Request。 */
function request(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers })
}

describe('requireControlRequest', () => {
  it('localhost 无 token 可通过', () => {
    const denied = requireControlRequest(request('http://localhost:3000/api/sessions'), {})
    expect(denied).toBeNull()
  })

  it('带 Origin/Referer 时必须同源', async () => {
    const denied = requireControlRequest(
      request('http://localhost:3000/api/chat/stream', {
        origin: 'https://evil.example',
      }),
      {},
    )
    expect(denied?.status).toBe(403)
    expect(await denied?.json()).toEqual({ detail: 'Cross-origin control request denied.' })
  })

  it('非本地且未配置 token 时 fail closed', async () => {
    const denied = requireControlRequest(request('https://kodeks.example/api/sessions'), {})
    expect(denied?.status).toBe(503)
    expect(await denied?.json()).toEqual({
      detail: 'KODEKS_CONTROL_TOKEN is required for non-local control API.',
    })
  })

  it('非本地 token 可通过 Authorization/header/cookie 三种绑定', () => {
    const env = { KODEKS_CONTROL_TOKEN: 'secret' }
    expect(
      requireControlRequest(
        request('https://kodeks.example/api/sessions', {
          authorization: 'Bearer secret',
        }),
        env,
      ),
    ).toBeNull()
    expect(
      requireControlRequest(
        request('https://kodeks.example/api/sessions', {
          'x-kodeks-control-token': 'secret',
        }),
        env,
      ),
    ).toBeNull()
    expect(
      requireControlRequest(
        request('https://kodeks.example/api/sessions', {
          cookie: 'kodeks_control_token=secret',
        }),
        env,
      ),
    ).toBeNull()
  })

  it('配置 token 后缺失或错误 token 拒绝', async () => {
    const denied = requireControlRequest(
      request('https://kodeks.example/api/sessions', {
        authorization: 'Bearer wrong',
      }),
      { KODEKS_CONTROL_TOKEN: 'secret' },
    )
    expect(denied?.status).toBe(401)
    expect(await denied?.json()).toEqual({ detail: 'Control token is required.' })
  })
})
