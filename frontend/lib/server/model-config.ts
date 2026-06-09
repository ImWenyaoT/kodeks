// frontend/lib/server/model-config.ts
// 模型配置解释层：逐字段忠实移植自 Python src/kodeks/model_config.py。
// provider/env 解析、reasoning effort、模型目录 catalog、上游配置、废弃 env 防御、is_local_http_url。
// 纯函数 + 数据结构，不依赖 Next.js 运行时；被 config.ts 与路由层、测试共用。
//
// 保真红线（见 .remember/migration-specs/10-bridge.md §H）：
//  · Python `x or y` 对空串也回退 —— 一律用 `||` 复刻，绝不用 `??`。
//  · `_string_value`：仅当值是 str 且 strip() 后非空时返回 strip 后的值，否则 undefined。
//  · catalog：两个默认 DeepSeek 选项恒在最前，primary 恒为 deepseek/deepseek-v4-pro；只保留 DeepSeek。
//  · deprecated env / provider 防御：逐字错误消息见 Python 源码。

// ── 契约类型（移植自 Python src/kodeks/contracts.py，camelCase alias 直接落地）──

/** 受支持的 reasoning effort 取值（contracts.py:10）。 */
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh'

/** 受支持的模型 API 形状（contracts.py:9）。 */
export type ConfiguredModelApi = 'responses' | 'chat-completions'

/**
 * 返回给前端选择器的无密钥模型选项（移植 ConfiguredModelOption，contracts.py:45-58）。
 * 字段直接采用 camelCase alias：providerId/providerName/modelId/modelName/requiresBridge/baseURL。
 */
export type ConfiguredModelOption = {
  ref: string
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  api: ConfiguredModelApi
  requiresBridge: boolean
  baseURL: string | null
  configured: boolean
}

/**
 * `/api/models` 使用的模型目录 wire 形状（移植 ConfiguredModelCatalog，contracts.py:61-65）。
 */
export type ConfiguredModelCatalog = {
  primary: string | null
  models: ConfiguredModelOption[]
}

/** 运行时 env 形状：键到字符串或 null/undefined 的只读映射（复刻 Python Mapping[str, str | None]）。 */
export type RuntimeEnv = Record<string, string | null | undefined>

// ── 默认值常量（model_config.py:13-25）─────────────────────────────────────

export const DEFAULT_CHAT_COMPLETIONS_BASE_URL = 'https://api.deepseek.com'
export const DEFAULT_DEEPSEEK_MODEL = 'deepseek-v4-pro'
export const DEFAULT_DEEPSEEK_MODEL_REF = `deepseek/${DEFAULT_DEEPSEEK_MODEL}`
/** 内置默认 DeepSeek 模型选项：[model_id, model_name]（顺序即目录展示顺序）。 */
export const DEFAULT_DEEPSEEK_MODEL_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['deepseek-v4-pro', 'DeepSeek V4 Pro'],
  ['deepseek-v4-flash', 'DeepSeek V4 Flash'],
]
export const DEFAULT_BRIDGE_API_KEY = 'bridge'
export const DEFAULT_BRIDGE_BASE_URL = 'http://127.0.0.1:38440/v1'
export const DEFAULT_BRIDGE_MODEL = 'bridge'
export const DEFAULT_BRIDGE_REASONING_EFFORT: ReasoningEffort = 'high'
export const LOCAL_ENDPOINT_API_KEY = 'not-needed'
export const SUPPORTED_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
])

/** 已废弃、必须拒绝的模型 env 键集合（model_config.py:27-40）。 */
export const UNSUPPORTED_MODEL_ENV_KEYS: ReadonlySet<string> = new Set([
  'DEEPSEEK_REASONING_EFFORT',
  'KODEKS_BRIDGE_DEEPSEEK_API_KEY',
  'KODEKS_BRIDGE_DEEPSEEK_BASE_URL',
  'KODEKS_BRIDGE_DEEPSEEK_MODEL',
  'MOONBRIDGE_API_KEY',
  'MOONBRIDGE_BASE_URL',
  'MOONBRIDGE_ENABLED',
  'MOONBRIDGE_MODEL',
  'MOONBRIDGE_REASONING_EFFORT',
  'MOONBRIDGE_DEEPSEEK_API_KEY',
  'MOONBRIDGE_DEEPSEEK_BASE_URL',
  'MOONBRIDGE_DEEPSEEK_MODEL',
])
/** 不被支持的 provider 取值集合（model_config.py:41）。 */
export const UNSUPPORTED_PROVIDER_VALUES: ReadonlySet<string> = new Set([
  'bridge',
  'deepseek',
  'chat-completions',
])

/**
 * 稳定的配置错误，统一以 `model_configuration_error` 暴露（移植 ModelConfigurationError，model_config.py:44-47）。
 * 携带 `.code = 'model_configuration_error'`，供路由层映射为 wire 错误码。
 */
export class ModelConfigurationError extends Error {
  readonly code = 'model_configuration_error'
  constructor(message: string) {
    super(message)
    this.name = 'ModelConfigurationError'
  }
}

// ── 基础工具（复刻 Python 的 isinstance / _string_value / _object_value）────

/** 复刻 Python `isinstance(x, str)`：仅 JS string 视为字符串。 */
function isString(value: unknown): value is string {
  return typeof value === 'string'
}

/** 复刻 Python `isinstance(x, dict)`：普通对象（非 null、非数组）视为 dict。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 复刻 Python `_string_value`（model_config.py:488-491）：
 * 仅当值是 str 且 strip() 后非空时返回 strip 后的值，否则 undefined。
 */
function stringValue(value: unknown): string | undefined {
  if (isString(value)) {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/** 复刻 Python `_object_value`（model_config.py:482-485）：dict 返回自身，否则 undefined。 */
function objectValue(value: unknown): Record<string, unknown> | undefined {
  return isDict(value) ? value : undefined
}

/** 从 env 读取一个键，返回字符串或 undefined（把 null/undefined 归一为 undefined）。 */
function envGet(env: RuntimeEnv, key: string): string | undefined {
  const value = env[key]
  return value === null || value === undefined ? undefined : value
}

/** 复刻 Python `value is not None`：env 中某键是否“存在”（非 null/undefined）。 */
function envHas(env: RuntimeEnv, key: string): boolean {
  return env[key] !== null && env[key] !== undefined
}

// ── 公共入口：model_config_to_env（model_config.py:50-71）──────────────────

/**
 * 把用户模型配置展开为 env-style 运行时契约（移植 model_config_to_env）。
 * 顺序：先写 env 段，再写 model.chatCompletions 端点，再写 DeepSeek provider。
 * @param config 已展开 `${VAR}` 的用户配置对象。
 * @param requestedModelRef 请求的模型 ref（object，宽松）。
 */
export function modelConfigToEnv(
  config: Record<string, unknown>,
  requestedModelRef: unknown,
): Record<string, string> {
  const values: Record<string, string> = {}
  const model = objectValue(config.model)
  const rootModels = objectValue(config.models)
  writeEnvSection(values, objectValue(config.env))
  if (model !== undefined) {
    writeEndpoint(values, 'KODEKS_CHAT_COMPLETIONS', objectValue(model.chatCompletions))
  }
  writeDeepseekProvider(
    values,
    model,
    rootModels ? objectValue(rootModels.providers) : undefined,
    requestedModelRef,
  )
  return values
}

/**
 * 读取已配置的 DeepSeek 模型选项，忽略其它 provider（移植 configured_deepseek_models，model_config.py:74-85）。
 */
export function configuredDeepseekModels(
  config: Record<string, unknown>,
): ConfiguredModelOption[] {
  const model = objectValue(config.model)
  let provider = findDeepseekProvider(model, objectValue(config.models))
  if (provider === undefined) {
    provider = model ? objectValue(model.chatCompletions) : undefined
  }
  if (provider === undefined) {
    return []
  }
  return configuredModelsFromDeepseekProvider(provider)
}

/**
 * 加入默认 DeepSeek 选项并保持目录无密钥（移植 with_default_model_catalog，model_config.py:88-104）。
 * 两个默认选项恒在最前，primary 恒为 DEFAULT_DEEPSEEK_MODEL_REF；
 * 再接配置里 ref 不属于默认集合的模型。
 */
export function withDefaultModelCatalog(
  catalog: ConfiguredModelCatalog,
  env: RuntimeEnv,
): ConfiguredModelCatalog {
  const defaultOptions = DEFAULT_DEEPSEEK_MODEL_OPTIONS.map(([modelId, modelName]) =>
    createDefaultDeepseekOption(modelId, modelName, env),
  )
  const defaultRefs = new Set(defaultOptions.map((model) => model.ref))
  return {
    primary: DEFAULT_DEEPSEEK_MODEL_REF,
    models: [
      ...defaultOptions,
      ...catalog.models.filter((model) => !defaultRefs.has(model.ref)),
    ],
  }
}

/**
 * 从 env-style 运行时契约解析 provider 客户端选项（移植 resolve_model_client_options_from_env，model_config.py:107-124）。
 * 先做废弃 env 防御，再按 provider override / 配置 provider / 是否需要路由分支。
 * @returns 客户端选项对象，或 null（无需路由）。
 */
export function resolveModelClientOptionsFromEnv(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown = undefined,
  requestedProvider: unknown = undefined,
): Record<string, unknown> | null {
  assertNoDeprecatedModelEnv(env)
  const providerOverride = resolveProviderOverride(requestedProvider)
  if (providerOverride === 'moonbridge') {
    return resolveBridgeOptions(
      { ...env, KODEKS_MODEL_PROVIDER: 'moonbridge' },
      requestedReasoningEffort,
    )
  }
  const configuredProvider = resolveConfiguredProvider(env.KODEKS_MODEL_PROVIDER)
  if (configuredProvider === 'moonbridge') {
    return resolveBridgeOptions(env, requestedReasoningEffort)
  }
  return resolveBridgeOptionsIfConfigured(env, requestedReasoningEffort)
}

/**
 * 读取上游 Chat Completions API key，允许本地无鉴权端点（移植 read_chat_completions_api_key，model_config.py:127-133）。
 * 关键：`||` 复刻 Python `or` —— 空 api key 时回退本地 not-needed 逻辑。
 */
export function readChatCompletionsApiKey(env: RuntimeEnv): string | undefined {
  const baseUrl = readChatCompletionsBaseUrl(env)
  return (
    stringValue(env.KODEKS_CHAT_COMPLETIONS_API_KEY) ||
    (isLocalHttpUrl(baseUrl) ? LOCAL_ENDPOINT_API_KEY : undefined)
  )
}

/**
 * 读取 OpenAI 兼容 Chat Completions base URL（移植 read_chat_completions_base_url，model_config.py:136-141）。
 * `||` 复刻 Python `or`：空串也回退默认值。
 */
export function readChatCompletionsBaseUrl(env: RuntimeEnv): string {
  return envGet(env, 'KODEKS_CHAT_COMPLETIONS_BASE_URL') || DEFAULT_CHAT_COMPLETIONS_BASE_URL
}

/**
 * 读取 OpenAI 兼容 Chat Completions 模型 id（移植 read_chat_completions_model，model_config.py:144-147）。
 * `||` 复刻 Python `or`：空串也回退默认模型。
 */
export function readChatCompletionsModel(env: RuntimeEnv): string {
  return envGet(env, 'KODEKS_CHAT_COMPLETIONS_MODEL') || DEFAULT_DEEPSEEK_MODEL
}

/**
 * 读取 MoonBridge 上游配置并列出缺失必填键（移植 read_chat_completions_config，model_config.py:150-163）。
 * 返回 { apiKey, baseURL, model, missing }，apiKey 可能为 undefined。
 */
export function readChatCompletionsConfig(env: RuntimeEnv): Record<string, unknown> {
  const apiKey = readChatCompletionsApiKey(env)
  const baseUrl = readChatCompletionsBaseUrl(env)
  const model = readChatCompletionsModel(env)
  const missing: string[] = []
  if (!apiKey) {
    missing.push('KODEKS_CHAT_COMPLETIONS_API_KEY')
  }
  if (!baseUrl.trim()) {
    missing.push('KODEKS_CHAT_COMPLETIONS_BASE_URL')
  }
  if (!model.trim()) {
    missing.push('KODEKS_CHAT_COMPLETIONS_MODEL')
  }
  return { apiKey, baseURL: baseUrl, model, missing }
}

/**
 * 判断 URL 是否本地 HTTP 端点（可省略鉴权）（移植 is_local_http_url，model_config.py:166-176）。
 * scheme == 'http' 且 hostname ∈ {127.0.0.1, localhost, ::1}。
 * 注意：用 URL 解析复刻 Python urlparse；解析失败按非本地处理。
 */
export function isLocalHttpUrl(value: string | undefined | null): boolean {
  if (value === undefined || value === null) {
    return false
  }
  const parsed = parseUrl(value)
  if (parsed === undefined) {
    return false
  }
  const { scheme, hostname } = parsed
  return (
    scheme === 'http' &&
    (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1')
  )
}

/**
 * 以与 Python `urllib.parse.urlparse` 兼容的方式解析 scheme 与 hostname。
 * Python urlparse 对 `host:port` 去掉端口、对 IPv6 `[::1]` 去掉方括号；
 * 这里用 Node URL 解析（其 hostname 行为与之一致：IPv6 去括号、无端口）。
 */
function parseUrl(value: string): { scheme: string; hostname: string } | undefined {
  // Python urlparse 把 scheme 小写化；URL 也小写化 protocol。
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value)
  if (match === null) {
    return undefined
  }
  try {
    const url = new URL(value)
    // url.protocol 形如 'http:'，去掉尾随冒号。
    const scheme = url.protocol.slice(0, -1).toLowerCase()
    // url.hostname：IPv6 去方括号，无端口；空主机为 ''。
    return { scheme, hostname: url.hostname }
  } catch {
    return undefined
  }
}

// ── 内部：env 写入与 provider 展开 ─────────────────────────────────────────

/**
 * 仅把 DeepSeek provider 注册项展开为运行时 env（移植 _write_deepseek_provider，model_config.py:179-202）。
 * 若 requested ref 的 provider 非 deepseek 则不处理；model_id 解析有多级回退。
 */
function writeDeepseekProvider(
  values: Record<string, string>,
  model: Record<string, unknown> | undefined,
  rootProviders: Record<string, unknown> | undefined,
  requestedModelRef: unknown,
): void {
  const provider = findDeepseekProvider(model, rootProviders)
  if (provider === undefined) {
    return
  }
  const requested = splitModelRef(stringValue(requestedModelRef))
  if (requested !== undefined && requested[0] !== 'deepseek') {
    return
  }
  const modelId =
    requested !== undefined
      ? requested[1]
      : stringValue(provider.model) ||
        firstConfiguredModelId(provider) ||
        DEFAULT_DEEPSEEK_MODEL
  // endpoint 的 model 字段：provider.model 优先（空则回退 model_id），复刻 Python `provider.get("model") or model_id`。
  const endpoint = { ...provider, model: provider.model || modelId }
  values.KODEKS_MODEL_PROVIDER = 'moonbridge'
  writeEndpoint(values, 'KODEKS_CHAT_COMPLETIONS', endpoint)
}

/**
 * 从 env-style 配置创建一个内置 DeepSeek 模型选项（移植 _create_default_deepseek_option，model_config.py:205-227）。
 * configured = 有 api_key（非空）或 base_url 是本地 http。
 */
function createDefaultDeepseekOption(
  modelId: string,
  modelName: string,
  env: RuntimeEnv,
): ConfiguredModelOption {
  const baseUrl =
    envGet(env, 'KODEKS_CHAT_COMPLETIONS_BASE_URL') || DEFAULT_CHAT_COMPLETIONS_BASE_URL
  // Python `bool(env.get(...))`：None/'' 皆为 False；这里 null/undefined/'' 皆为 false。
  const configured = Boolean(envGet(env, 'KODEKS_CHAT_COMPLETIONS_API_KEY')) || isLocalHttpUrl(baseUrl)
  return {
    ref: `deepseek/${modelId}`,
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    modelId,
    modelName,
    api: 'chat-completions',
    requiresBridge: true,
    baseURL: baseUrl,
    configured,
  }
}

/**
 * 从 model 或 root 配置中找到受支持的 DeepSeek provider 项（移植 _find_deepseek_provider，model_config.py:230-242）。
 */
function findDeepseekProvider(
  model: Record<string, unknown> | undefined,
  rootModelsOrProviders: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  let providers = model ? objectValue(model.providers) : undefined
  if (providers === undefined && rootModelsOrProviders !== undefined) {
    // 复刻 `_object_value(root.get("providers")) or dict(root)`：providers 段优先，否则把 root 当作 providers 表。
    providers = objectValue(rootModelsOrProviders.providers) || { ...rootModelsOrProviders }
  }
  return providers ? objectValue(providers.deepseek) : undefined
}

/**
 * 把一个 DeepSeek provider 项转换为前端模型选项（移植 _configured_models_from_deepseek_provider，model_config.py:245-276）。
 * api 形状不被支持时返回 []；优先逐项展开 models，否则回退单一 fallback model。
 */
function configuredModelsFromDeepseekProvider(
  provider: Record<string, unknown>,
): ConfiguredModelOption[] {
  const api = normalizeApiShape(provider.api)
  if (api !== undefined && api !== 'chat-completions') {
    return []
  }
  const rawModels = provider.models
  const explicit: ConfiguredModelOption[] = []
  if (Array.isArray(rawModels)) {
    for (const model of rawModels) {
      const item = objectValue(model)
      const modelId = item ? stringValue(item.id) : undefined
      if (modelId === undefined) {
        continue
      }
      // name 优先取 item.name（非空 str），否则回退 model_id（复刻 Python `... or model_id`）。
      const modelName = (item !== undefined ? stringValue(item.name) : undefined) || modelId
      explicit.push(createConfiguredModelOption(provider, modelId, modelName))
    }
  }
  const fallbackModelId = stringValue(provider.model)
  if (explicit.length > 0 || fallbackModelId === undefined) {
    return explicit
  }
  return [createConfiguredModelOption(provider, fallbackModelId, fallbackModelId)]
}

/**
 * 为一个 model id 创建无密钥前端模型选项（移植 _create_configured_model_option，model_config.py:279-301）。
 * configured = base_url 非空且（apiKey 非空或 base_url 本地 http）。
 */
function createConfiguredModelOption(
  provider: Record<string, unknown>,
  modelId: string,
  modelName: string,
): ConfiguredModelOption {
  const baseUrl = stringValue(provider.baseURL)
  const apiKey = stringValue(provider.apiKey)
  const configured =
    baseUrl !== undefined && (apiKey !== undefined || isLocalHttpUrl(baseUrl))
  return {
    ref: `deepseek/${modelId}`,
    providerId: 'deepseek',
    providerName: 'DeepSeek',
    modelId,
    modelName,
    api: 'chat-completions',
    requiresBridge: true,
    // Python base_url 可能为 None；这里用 null 对齐 ConfiguredModelOption.baseURL 默认 None。
    baseURL: baseUrl === undefined ? null : baseUrl,
    configured,
  }
}

/**
 * 从 env-style 值构建 MoonBridge 客户端选项（移植 _resolve_bridge_options，model_config.py:304-321）。
 * 所有回退均用 `||` 复刻 Python `or`（空串也回退）。
 */
function resolveBridgeOptions(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown,
): Record<string, unknown> {
  return {
    provider: 'moonbridge',
    apiKey: envGet(env, 'KODEKS_BRIDGE_API_KEY') || DEFAULT_BRIDGE_API_KEY,
    baseURL: trimTrailingSlash(envGet(env, 'KODEKS_BRIDGE_BASE_URL') || DEFAULT_BRIDGE_BASE_URL),
    model: envGet(env, 'KODEKS_BRIDGE_MODEL') || DEFAULT_BRIDGE_MODEL,
    reasoningEffort: resolveReasoningEffort(
      requestedReasoningEffort,
      env.KODEKS_BRIDGE_REASONING_EFFORT,
      DEFAULT_BRIDGE_REASONING_EFFORT,
    ),
  }
}

/**
 * 仅当 env 要求模型路由时才返回桥选项（移植 _resolve_bridge_options_if_configured，model_config.py:324-333）。
 */
function resolveBridgeOptionsIfConfigured(
  env: RuntimeEnv,
  requestedReasoningEffort: unknown,
): Record<string, unknown> | null {
  return shouldUseBridge(env) ? resolveBridgeOptions(env, requestedReasoningEffort) : null
}

/**
 * 判断是否配置了任一模型路由键（移植 _should_use_bridge，model_config.py:336-353）。
 * 任一键“存在”（非 null/undefined）即为真。
 */
function shouldUseBridge(env: RuntimeEnv): boolean {
  const keys = [
    'KODEKS_MODEL_PROVIDER',
    'KODEKS_BRIDGE_ENABLED',
    'KODEKS_BRIDGE_API_KEY',
    'KODEKS_CHAT_COMPLETIONS_API_KEY',
    'KODEKS_CHAT_COMPLETIONS_BASE_URL',
    'KODEKS_CHAT_COMPLETIONS_MODEL',
    'KODEKS_BRIDGE_BASE_URL',
    'KODEKS_BRIDGE_MODEL',
  ]
  return keys.some((key) => envHas(env, key))
}

/**
 * 校验显式 provider override（移植 _resolve_provider_override，model_config.py:356-369）。
 * moonbridge → 通过；openai/responses → 产品边界外报错；UNSUPPORTED_PROVIDER_VALUES → 内部适配器报错；其它 → null。
 */
function resolveProviderOverride(value: unknown): 'moonbridge' | null {
  if (value === 'moonbridge') {
    return 'moonbridge'
  }
  if (value === 'openai' || value === 'responses') {
    throw new ModelConfigurationError(
      'Direct Responses model providers are outside the Kodeks product boundary. Configure an OpenAI-compatible Chat Completions endpoint through MoonBridge.',
    )
  }
  if (isString(value) && UNSUPPORTED_PROVIDER_VALUES.has(value)) {
    throw new ModelConfigurationError(
      `Model provider "${value}" is unsupported. Use a deepseek/<model> ref; MoonBridge remains an internal adapter.`,
    )
  }
  return null
}

/**
 * 校验配置的 provider 值（移植 _resolve_configured_provider，model_config.py:372-391）。
 * 空 → null；moonbridge → 通过；openai/responses → 产品边界外报错；
 * UNSUPPORTED_PROVIDER_VALUES → 内部适配器报错；其它 → 通用 unsupported 报错。
 */
function resolveConfiguredProvider(value: string | null | undefined): 'moonbridge' | null {
  if (!value) {
    return null
  }
  if (value === 'moonbridge') {
    return 'moonbridge'
  }
  if (value === 'openai' || value === 'responses') {
    throw new ModelConfigurationError(
      'Direct Responses model providers are outside the Kodeks product boundary. Configure an OpenAI-compatible Chat Completions endpoint through MoonBridge.',
    )
  }
  if (UNSUPPORTED_PROVIDER_VALUES.has(value)) {
    throw new ModelConfigurationError(
      `KODEKS_MODEL_PROVIDER="${value}" is unsupported. Use a deepseek/<model> ref; MoonBridge remains an internal adapter.`,
    )
  }
  throw new ModelConfigurationError(
    `Unsupported KODEKS_MODEL_PROVIDER="${value}". Use "moonbridge" for the Chat Completions route.`,
  )
}

/**
 * 当旧模型 env 别名仍存在时立即报错（移植 _assert_no_deprecated_model_env，model_config.py:394-401）。
 */
function assertNoDeprecatedModelEnv(env: RuntimeEnv): void {
  for (const key of UNSUPPORTED_MODEL_ENV_KEYS) {
    if (envHas(env, key)) {
      throw new ModelConfigurationError(
        `${key} is unsupported. Configure API_KEY or DEEPSEEK_API_KEY for the MoonBridge Chat Completions route.`,
      )
    }
  }
}

/**
 * 把配置端点对象写入带前缀的 env-style 键（移植 _write_endpoint，model_config.py:404-414）。
 */
function writeEndpoint(
  values: Record<string, string>,
  prefix: string,
  endpoint: Record<string, unknown> | undefined,
): void {
  if (endpoint === undefined) {
    return
  }
  writeString(values, `${prefix}_API_KEY`, endpoint.apiKey)
  writeString(values, `${prefix}_BASE_URL`, endpoint.baseURL)
  writeString(values, `${prefix}_MODEL`, endpoint.model)
  writeString(values, `${prefix}_REASONING_EFFORT`, endpoint.reasoningEffort)
}

/**
 * 把显式 config env 段复制进 env-style 值（移植 _write_env_section，model_config.py:417-425）。
 */
function writeEnvSection(
  values: Record<string, string>,
  env: Record<string, unknown> | undefined,
): void {
  if (env === undefined) {
    return
  }
  for (const [key, value] of Object.entries(env)) {
    writeString(values, key, value)
  }
}

/**
 * 把非空字符串值写入 env 映射（移植 _write_string，model_config.py:428-433）。
 */
function writeString(values: Record<string, string>, key: string, value: unknown): void {
  const string = stringValue(value)
  if (string !== undefined) {
    values[key] = string
  }
}

/**
 * 归一化受支持的模型 API 形状别名（移植 _normalize_api_shape，model_config.py:436-448）。
 */
function normalizeApiShape(value: unknown): 'responses' | 'chat-completions' | undefined {
  if (
    value === 'chat-completions' ||
    value === 'openai-completions' ||
    value === 'completions' ||
    value === 'deepseek'
  ) {
    return 'chat-completions'
  }
  return undefined
}

/**
 * 按 config / 默认优先级解析请求的 reasoning effort（移植 _resolve_reasoning_effort，model_config.py:451-460）。
 */
function resolveReasoningEffort(
  requested: unknown,
  configured: string | null | undefined,
  fallback: ReasoningEffort,
): ReasoningEffort {
  if (isString(requested) && SUPPORTED_REASONING_EFFORTS.has(requested)) {
    return requested as ReasoningEffort
  }
  if (configured !== null && configured !== undefined && SUPPORTED_REASONING_EFFORTS.has(configured)) {
    return configured as ReasoningEffort
  }
  return fallback
}

/**
 * 把 provider/model ref 拆分为 [provider, model]（移植 _split_model_ref，model_config.py:463-469）。
 * 无 '/'、provider 或 model 为空时返回 undefined。
 */
function splitModelRef(value: string | undefined): [string, string] | undefined {
  if (value === undefined || !value.includes('/')) {
    return undefined
  }
  const index = value.indexOf('/')
  const provider = value.slice(0, index)
  const model = value.slice(index + 1)
  return provider && model ? [provider, model] : undefined
}

/**
 * 读取 provider 配置中第一个显式 model id（移植 _first_configured_model_id，model_config.py:472-479）。
 */
function firstConfiguredModelId(provider: Record<string, unknown>): string | undefined {
  const models = provider.models
  if (!Array.isArray(models) || models.length === 0) {
    return undefined
  }
  const first = objectValue(models[0])
  return first ? stringValue(first.id) : undefined
}

/**
 * 去掉 URL 末尾的一个斜杠（移植 _trim_trailing_slash，model_config.py:494-497）。
 */
function trimTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}
