// frontend/lib/server/tools/helpers.ts
// 工具参数解析、MCP manifest 解析、紧凑输出助手：逐字移植 Python src/kodeks/tools/helpers.py。
//
// 保真红线（见 50-tools-security.md §8、保真风险 2/4/5/13）：
//  · stringArgument allow_empty 双行为：true 返回原始未 trim 值，false 返回 trim 后值。
//  · clampInteger 拒绝非整数/NaN/布尔（JS 用 Number.isInteger + typeof 排除 boolean）。
//  · jsonOutput 紧凑序列化（JSON.stringify 默认无空格），键插入序逐字。
//  · failedOutput 展开顺序：error 在前，extra 在后。
import type { ToolExecutionResult, ToolRegistryServices } from './types'

/**
 * 从模型给出的 JSON 读一个必填字符串参数（移植 string_argument，helpers.py:13-24）。
 * 非 string → null；trimmed = value.trim()；!allowEmpty && !trimmed → null。
 * 关键双行为：allowEmpty=true 返回原始未 trim 的 value；allowEmpty=false 返回 trim 后的 trimmed。
 * @param args 模型参数。
 * @param name 参数名。
 * @param allowEmpty 是否允许空串并保留原文（write_file content 用 true）。
 */
export function stringArgument(
  args: Record<string, unknown>,
  name: string,
  allowEmpty = false,
): string | null {
  const value = args[name]
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!allowEmpty && !trimmed) {
    return null
  }
  return allowEmpty ? value : trimmed
}

/**
 * 读取并夹取一个数值参数（移植 clamp_integer，helpers.py:27-32）。
 * 非整数（含 NaN）或布尔 → fallback；否则 min(maximum, max(minimum, value))。
 * 关键：Python 排除 bool（int 子类）；JS 用 typeof !== 'number' || !Number.isInteger 排除非整数与 NaN，
 * 并显式排除 boolean（typeof 已保证非 boolean，但保留语义说明）。
 */
export function clampInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fallback
  }
  return Math.min(maximum, Math.max(minimum, value))
}

/**
 * 读取可选的内存层过滤器（移植 read_memory_layers，helpers.py:35-45）。
 * 非数组 → ["atom","artifact"]；过滤出值为 "atom"/"artifact" 的字符串项；空 → ["atom","artifact"]。
 */
export function readMemoryLayers(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return ['atom', 'artifact']
  }
  const layers = value.filter(
    (item): item is string =>
      typeof item === 'string' && (item === 'atom' || item === 'artifact'),
  )
  return layers.length > 0 ? layers : ['atom', 'artifact']
}

/**
 * 从环境变量读取 MCP server manifests（移植 read_mcp_server_manifests，helpers.py:48-66）。
 * 优先 KODEKS_MCP_SERVERS（JSON）；否则 KODEKS_MCP_SERVER_URL（单条），无则 []。
 * 关键：label/skipApproval 用 Python `x or "default"` / `== "true"` 语义，分别用 ||、严格 === 复刻。
 */
export function readMcpServerManifests(
  environment: Record<string, string | null | undefined>,
): Array<Record<string, unknown>> {
  const rawServers = environment.KODEKS_MCP_SERVERS
  if (rawServers) {
    return parseMcpServerManifests(rawServers)
  }
  const url = environment.KODEKS_MCP_SERVER_URL
  if (!url) {
    return []
  }
  return [
    {
      label: environment.KODEKS_MCP_SERVER_LABEL || 'default',
      url: url.trim(),
      allowedTools: splitCsv(environment.KODEKS_MCP_ALLOWED_TOOLS),
      skipApproval: environment.KODEKS_MCP_SKIP_APPROVAL === 'true',
    },
  ]
}

/**
 * 解析 JSON MCP manifests 并丢弃畸形项（移植 parse_mcp_server_manifests，helpers.py:69-99）。
 * JSON 解析失败 → []；非数组包装成单元素；逐项要求 label/url 均为字符串否则丢弃；
 * allowedTools 为数组时取其中字符串，为字符串时 split_csv，否则 []；skipApproval = item.skipApproval === true。
 */
export function parseMcpServerManifests(rawServers: string): Array<Record<string, unknown>> {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawServers)
  } catch {
    return []
  }
  const items = Array.isArray(parsed) ? parsed : [parsed]
  const manifests: Array<Record<string, unknown>> = []
  for (const item of items) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      continue
    }
    const record = item as Record<string, unknown>
    const label = record.label
    const url = record.url
    if (typeof label !== 'string' || typeof url !== 'string') {
      continue
    }
    const rawAllowed = record.allowedTools
    const allowedTools = Array.isArray(rawAllowed)
      ? rawAllowed.filter((tool): tool is string => typeof tool === 'string')
      : splitCsv(typeof rawAllowed === 'string' ? rawAllowed : null)
    manifests.push({
      label,
      url,
      allowedTools,
      skipApproval: record.skipApproval === true,
    })
  }
  return manifests
}

/**
 * 把逗号分隔的环境值切成非空 token（移植 split_csv，helpers.py:102-107）。
 * null/undefined → []；按 ',' 切分，trim 后保留非空。
 */
export function splitCsv(value: string | null | undefined): string[] {
  if (value === null || value === undefined) {
    return []
  }
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

/**
 * 紧凑序列化工具输出（移植 json_output，helpers.py:126-129）。
 * JSON.stringify 默认无空格分隔（对应 Python separators=(",",":")），键顺序即对象插入序。
 */
export function jsonOutput(payload: Record<string, unknown>): string {
  return JSON.stringify(payload)
}

/** 构造一个成功的 JSON 工具结果（移植 completed_output，helpers.py:110-113）。状态 "completed"。 */
export function completedOutput(payload: Record<string, unknown>): ToolExecutionResult {
  return { status: 'completed', output: jsonOutput(payload) }
}

/**
 * 构造一个失败的 JSON 工具结果（移植 failed_output，helpers.py:116-123）。
 * 形状 {ok:false, error:<message>, ...extra}：error 在前，extra 字段在后（保真风险 13）。
 */
export function failedOutput(
  message: string,
  extra?: Record<string, unknown>,
): ToolExecutionResult {
  return {
    status: 'failed',
    output: jsonOutput({ ok: false, error: message, ...(extra ?? {}) }),
  }
}

/** 返回配置的工具环境或进程 env（移植 runtime_environment，helpers.py:132-135）。 */
export function runtimeEnvironment(
  services: ToolRegistryServices,
): Record<string, string | null | undefined> {
  return services.environment !== undefined ? services.environment : process.env
}

/** 把未知抛出值转成可读工具错误（移植 error_message，helpers.py:138-141）。 */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }
  return String(error)
}
