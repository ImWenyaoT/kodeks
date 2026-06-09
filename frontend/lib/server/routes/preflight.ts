// frontend/lib/server/routes/preflight.ts
// Bridge preflight 路由逻辑（移植 bridge_routes.py:40-99 + check_chat_completions_upstream:163-190）。
// 复刻状态机：ModelConfigurationError → model_configuration_error；model_options null → model_provider_missing；
// base 字段 + upstream missing → moonbridge_upstream_missing；checkUpstream 失败 → 其 code/reason；全过 → ready。
// 错误 envelope：preflight 始终返回 200 body（status='unavailable'），不抛 HTTP 错误（保真风险 2, 11）。
import { NextResponse } from 'next/server'
import {
  ModelConfigurationError,
  loadModelRuntimeEnv,
  readChatCompletionsApiKey,
  readChatCompletionsConfig,
  resolveModelClientOptions,
  type RuntimeEnv,
} from '../config'

/** upstream 探测结果：失败返回 {code, reason}，成功返回 null。 */
export type UpstreamCheck = (
  baseUrl: string,
  apiKey: string | null,
) => Promise<{ code: string; reason: string } | null>

/** preflight 构造参数（可注入 env + checkUpstream，便于单测）。 */
export interface BridgePreflightArgs {
  /** 请求体（容错后的 dict，含 provider?/model?）。 */
  body: Record<string, unknown>
  /** 运行时 env（生产传 process.env）。 */
  env: RuntimeEnv
  /** 上游探测注入点（默认 defaultUpstreamCheck）。 */
  checkUpstream?: UpstreamCheck
}

/**
 * 返回诊断 provider 标签（移植 _requested_provider，bridge_routes.py:193-196）。
 * value === 'moonbridge' → 'moonbridge'，否则一律 'auto'（保真风险 11）。
 */
function requestedProvider(value: unknown): string {
  return value === 'moonbridge' ? 'moonbridge' : 'auto'
}

/**
 * 生成 6 位微秒精度的 ISO-Z 时间戳（复刻 Python datetime.now(UTC).isoformat().replace('+00:00','Z')）。
 * JS Date.toISOString() 只有 3 位毫秒；这里补足 6 位微秒（末 3 位补 0）以对齐 Python 格式（保真风险 10）。
 */
function isoMicrosecondsZ(): string {
  const iso = new Date().toISOString() // 形如 2026-06-08T12:34:56.789Z
  return iso.replace(/\.(\d{3})Z$/, '.$1000Z')
}

/**
 * 默认上游探测（移植 check_chat_completions_upstream，bridge_routes.py:163-190）。
 * GET {base}/models，有 key 时带 Authorization: Bearer；AbortController 2000ms 超时。
 * 网络异常/超时 → moonbridge_upstream_unreachable；HTTP ≥400 → moonbridge_upstream_unhealthy。
 */
export const defaultUpstreamCheck: UpstreamCheck = async (baseUrl, apiKey) => {
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  let response: globalThis.Response
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/models`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    })
  } catch (error) {
    const name = error instanceof Error ? error.constructor.name : 'Error'
    return {
      code: 'moonbridge_upstream_unreachable',
      reason: `Configured Chat Completions upstream is unreachable: ${name}.`,
    }
  } finally {
    clearTimeout(timer)
  }
  if (response.status >= 400) {
    return {
      code: 'moonbridge_upstream_unhealthy',
      reason: `Configured Chat Completions upstream returned HTTP ${response.status}.`,
    }
  }
  return null
}

/**
 * 报告 MoonBridge 就绪诊断（移植 bridge_preflight，bridge_routes.py:40-99）。
 * 请求体 {provider?, model?}。所有路径返回 200，body.status ∈ {'unavailable','ready'}。
 * 键顺序严格对齐 Python dict 字面量插入顺序（保真风险 7）。
 */
export async function bridgePreflight(args: BridgePreflightArgs): Promise<NextResponse> {
  const { body, env, checkUpstream = defaultUpstreamCheck } = args
  const provider = requestedProvider(body.provider)
  const checkedAt = isoMicrosecondsZ()

  let modelOptions: Record<string, unknown> | null
  try {
    const modelEnv = loadModelRuntimeEnv(env, body.model)
    modelOptions = resolveModelClientOptions(modelEnv, undefined, body.provider)
    if (modelOptions === null) {
      return NextResponse.json({
        status: 'unavailable',
        provider,
        code: 'model_provider_missing',
        reason:
          'No OpenAI-compatible Chat Completions provider is configured. Set API_KEY or DEEPSEEK_API_KEY for the MoonBridge route.',
        checkedAt,
      })
    }
    const upstream = readChatCompletionsConfig(modelEnv)
    const base = {
      provider,
      resolvedProvider: 'moonbridge',
      bridgeBaseURL: modelOptions.baseURL,
      bridgeModel: modelOptions.model,
      upstreamBaseURL: upstream.baseURL,
      upstreamModel: upstream.model,
      checkedAt,
    }
    const missing = upstream.missing as string[]
    if (missing.length > 0) {
      return NextResponse.json({
        ...base,
        status: 'unavailable',
        code: 'moonbridge_upstream_missing',
        reason: `Missing upstream Chat Completions configuration: ${missing.join(', ')}.`,
      })
    }
    const upstreamError = await checkUpstream(
      String(upstream.baseURL),
      readChatCompletionsApiKey(modelEnv) ?? null,
    )
    if (upstreamError !== null) {
      return NextResponse.json({
        ...base,
        status: 'unavailable',
        code: upstreamError.code,
        reason: upstreamError.reason,
      })
    }
    return NextResponse.json({ ...base, status: 'ready' })
  } catch (error) {
    if (error instanceof ModelConfigurationError) {
      return NextResponse.json({
        status: 'unavailable',
        provider,
        code: error.code,
        reason: error.message,
        checkedAt,
      })
    }
    throw error
  }
}
