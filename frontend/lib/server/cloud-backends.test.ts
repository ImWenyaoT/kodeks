// frontend/lib/server/cloud-backends.test.ts
// M6 云端后端「可单测的纯逻辑」覆盖：blob URL 判定 / blob pathname 推导 / sandbox 超时竞速 /
// sandbox 后端启用判定 / createDatabase 接受 authToken（本地 url 仍工作）。
// 云端真实调用（put/fetch/Sandbox.create）本地无 token 不可测，故只测抽出的纯函数与增量兼容性。
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BlobArtifactStore,
  blobPathnameForRef,
  createDatabase,
  isBlobUrl,
} from './storage'
import {
  ExecutorTimeoutError,
  SandboxExecutor,
  withTimeout,
} from './execution'
import { shouldUseSandboxExecutor } from './routes/deps'

describe('isBlobUrl 判定', () => {
  it('http/https URL 为真', () => {
    expect(isBlobUrl('https://abc.public.blob.vercel-storage.com/memory-artifacts/x.md')).toBe(true)
    expect(isBlobUrl('http://example.com/x')).toBe(true)
    // 大小写不敏感。
    expect(isBlobUrl('HTTPS://EXAMPLE.COM/x')).toBe(true)
  })

  it('本地绝对路径 / 相对路径 / 空串为假', () => {
    expect(isBlobUrl('/home/user/.kodeks/memory-artifacts/x.md')).toBe(false)
    expect(isBlobUrl('memory-artifacts/x.md')).toBe(false)
    expect(isBlobUrl('')).toBe(false)
    // file: URL 不是 http(s)，按非 blob 处理。
    expect(isBlobUrl('file:/tmp/x.md')).toBe(false)
  })
})

describe('blobPathnameForRef 推导', () => {
  it('置于 memory-artifacts/ 前缀下并加 .md，与本地命名对齐', () => {
    expect(blobPathnameForRef('memref_0123456789abcdef')).toBe(
      'memory-artifacts/memref_0123456789abcdef.md',
    )
  })
})

describe('BlobArtifactStore.read 容错', () => {
  it('非 blob URL 句柄直接返回 null（永不抛）', async () => {
    const store = new BlobArtifactStore('fake-token')
    // 本地路径句柄（理论上 blob 后端不会写出）按「读不到」处理。
    await expect(store.read('/local/path/x.md')).resolves.toBeNull()
  })
})

describe('withTimeout 超时竞速', () => {
  it('work 先于超时完成时透传其结果', async () => {
    const result = await withTimeout(
      Promise.resolve('ok'),
      1000,
      () => new Error('should not fire'),
    )
    expect(result).toBe('ok')
  })

  it('超时先到时 reject onTimeout() 产出的错误', async () => {
    vi.useFakeTimers()
    try {
      // 永不 resolve 的 work，确保走超时支。
      const never = new Promise<string>(() => {})
      const pending = withTimeout(never, 50, () => new ExecutorTimeoutError('timed out'))
      const assertion = expect(pending).rejects.toBeInstanceOf(ExecutorTimeoutError)
      await vi.advanceTimersByTimeAsync(50)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('shouldUseSandboxExecutor 启用判定', () => {
  it('VERCEL + OIDC token → 启用', () => {
    expect(
      shouldUseSandboxExecutor({ VERCEL: '1', VERCEL_OIDC_TOKEN: 'tok' }),
    ).toBe(true)
  })

  it('VERCEL + access token → 启用', () => {
    expect(
      shouldUseSandboxExecutor({ VERCEL: '1', VERCEL_TOKEN: 'tok' }),
    ).toBe(true)
  })

  it('仅 VERCEL（无任何鉴权）→ 不启用', () => {
    expect(shouldUseSandboxExecutor({ VERCEL: '1' })).toBe(false)
  })

  it('有鉴权但不在 Vercel（本地）→ 不启用', () => {
    expect(
      shouldUseSandboxExecutor({ VERCEL_OIDC_TOKEN: 'tok' }),
    ).toBe(false)
  })

  it('空 env（本地默认）→ 不启用', () => {
    expect(shouldUseSandboxExecutor({})).toBe(false)
  })
})

describe('SandboxExecutor 构造', () => {
  it('可构造（默认 runtime），实现 Executor.run', () => {
    const executor = new SandboxExecutor()
    expect(typeof executor.run).toBe('function')
  })
})

describe('createDatabase authToken 增量兼容', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('本地 :memory: url 传 authToken 仍正常建库（token 对本地无害）', async () => {
    const db = await createDatabase(':memory:', { authToken: 'irrelevant-for-memory' })
    // schema 正常初始化，版本可读。
    await expect(db.getSchemaVersion()).resolves.toBeGreaterThanOrEqual(1)
    db.close()
  })

  it('不传 authToken 时本地 url 行为不变', async () => {
    const db = await createDatabase(':memory:')
    await expect(db.getSchemaVersion()).resolves.toBeGreaterThanOrEqual(1)
    db.close()
  })
})
