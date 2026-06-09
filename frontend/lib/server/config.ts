// frontend/lib/server/config.ts
// 运行时配置文件加载：逐字段忠实移植自 Python src/kodeks/config.py。
// 配置文件/dotenv 加载、env 别名归一化、${VAR} 展开、配置路径发现。
// 用 Node os/fs/path 复刻 Python pathlib + os.environ 语义；被路由层与测试共用。
//
// 保真红线（见 .remember/migration-specs/10-bridge.md §H）：
//  · Python `x or y` 对空串也回退 —— 一律用 `||` 复刻，绝不用 `??`。
//  · _string_value：仅当值是 str 且 strip() 后非空时返回 strip 后的值，否则 undefined。
//  · dotenv：仅当 env 是“进程 env”或提供了 KODEKS_WORKSPACE_ROOT 时才读 workspace .env；
//    process/显式 env 覆盖 dotenv。
//  · 配置路径发现优先级：CONFIG_PATH 覆盖 > (CONFIG_DIR 设置时直接用 user) > workspace > user > legacy > user。

import { existsSync, readFileSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { resolve as pathResolve } from 'node:path'

import {
  type ConfiguredModelCatalog,
  type RuntimeEnv,
  DEFAULT_DEEPSEEK_MODEL,
  ModelConfigurationError,
  configuredDeepseekModels,
  isLocalHttpUrl,
  modelConfigToEnv,
  readChatCompletionsApiKey,
  readChatCompletionsBaseUrl,
  readChatCompletionsConfig,
  readChatCompletionsModel,
  resolveModelClientOptionsFromEnv,
  withDefaultModelCatalog,
} from './model-config'

// 重导出公共 API，复刻 Python config.py 的 re-export（__all__）。
export {
  DEFAULT_DEEPSEEK_MODEL,
  ModelConfigurationError,
  isLocalHttpUrl,
  readChatCompletionsApiKey,
  readChatCompletionsBaseUrl,
  readChatCompletionsConfig,
  readChatCompletionsModel,
}
export type { RuntimeEnv }

const CONFIG_FILE_NAME = 'config.json'
const CONFIG_DIR_NAME = '.kodeks'
const DOTENV_FILE_NAME = '.env'

/** 友好模型 env 别名 → canonical 运行时键（移植 MODEL_ENV_ALIASES，config.py:33-40）。 */
export const MODEL_ENV_ALIASES: Readonly<Record<string, string>> = {
  API_KEY: 'KODEKS_CHAT_COMPLETIONS_API_KEY',
  DEEPSEEK_API_KEY: 'KODEKS_CHAT_COMPLETIONS_API_KEY',
  BASE_URL: 'KODEKS_CHAT_COMPLETIONS_BASE_URL',
  DEEPSEEK_BASE_URL: 'KODEKS_CHAT_COMPLETIONS_BASE_URL',
  MODEL: 'KODEKS_CHAT_COMPLETIONS_MODEL',
  DEEPSEEK_MODEL: 'KODEKS_CHAT_COMPLETIONS_MODEL',
}

/**
 * home 目录解析 seam：默认委托给 Node os.homedir()（其在 linux/mac 下读 $HOME），
 * 提供极薄覆盖点以便测试注入假 home（复刻 Python 测试 monkeypatch Path.home）。
 * 默认运行时行为不变。
 */
let homeResolver: () => string = homedir

/** 覆盖 home 解析器（仅供测试使用），返回恢复函数。 */
export function setHomeResolverForTesting(resolver: () => string): () => void {
  const previous = homeResolver
  homeResolver = resolver
  return () => {
    homeResolver = previous
  }
}

// ── 基础工具（复刻 Python _string_value / 路径展开）────────────────────────

/**
 * 复刻 Python `_string_value`（config.py:286-287）：
 * 仅当值是 str 且 strip() 后非空时返回 strip 后的值，否则 undefined。
 */
function stringValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed) return trimmed
  }
  return undefined
}

/** 复刻 Python `isinstance(x, dict)`：普通对象（非 null、非数组）视为 dict。 */
function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 从 RuntimeEnv 读取键，归一 null/undefined（复刻 Python Mapping.get → None）。 */
function envGet(env: RuntimeEnv, key: string): string | null | undefined {
  return env[key]
}

/**
 * 复刻 Python `Path(x).expanduser()`：把开头的 `~` 展开为 home 目录。
 * 仅处理 `~` 与 `~/...`（与 pathlib 对当前用户 home 的处理一致）。
 */
function expanduser(value: string): string {
  if (value === '~') {
    return homeResolver()
  }
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return joinPath(homeResolver(), value.slice(2))
  }
  return value
}

/**
 * 复刻 Python `Path(x).expanduser().resolve()`：先展开 `~`，再解析为绝对路径。
 * resolve 以当前工作目录为基准（与 pathlib.resolve 一致）。
 */
function expanduserResolve(value: string): string {
  return pathResolve(expanduser(value))
}

/** 把基路径与子路径拼接（统一用 POSIX/平台分隔符，借助 path.resolve 归一）。 */
function joinPath(base: string, ...parts: string[]): string {
  return pathResolve(base, ...parts)
}

/**
 * 复刻 Python `root.resolve() / CONFIG_DIR_NAME`：把已展开的 root 解析为绝对路径并附加子段。
 */
function resolveDir(root: string, ...parts: string[]): string {
  return joinPath(pathResolve(root), ...parts)
}

// ── 路径发现（config.py:60-107）────────────────────────────────────────────

/**
 * 解析用户级 Kodeks 配置目录（移植 resolve_kodeks_config_dir，config.py:60-67）。
 * KODEKS_CONFIG_DIR 覆盖（展开+解析）优先；否则 home/.kodeks。
 */
export function resolveKodeksConfigDir(env: RuntimeEnv = processEnv()): string {
  const override = stringValue(envGet(env, 'KODEKS_CONFIG_DIR'))
  if (override !== undefined) {
    return expanduserResolve(override)
  }
  return joinPath(homeResolver(), CONFIG_DIR_NAME)
}

/**
 * 跨显式 / workspace / 用户作用域解析配置路径（移植 resolve_kodeks_config_path，config.py:70-89）。
 * 优先级：CONFIG_PATH 覆盖 > (CONFIG_DIR 设置时直接用 user config) > workspace 存在 > user 存在 > legacy 存在 > user。
 */
export function resolveKodeksConfigPath(env: RuntimeEnv = processEnv()): string {
  const override = stringValue(envGet(env, 'KODEKS_CONFIG_PATH'))
  if (override !== undefined) {
    return expanduserResolve(override)
  }
  const configDirOverride = stringValue(envGet(env, 'KODEKS_CONFIG_DIR'))
  const userConfig = joinPath(resolveKodeksConfigDir(env), CONFIG_FILE_NAME)
  if (configDirOverride !== undefined) {
    return userConfig
  }
  const workspaceConfig = joinPath(resolveKodeksWorkspaceConfigDir(env), CONFIG_FILE_NAME)
  if (existsSync(/* turbopackIgnore: true */ workspaceConfig)) {
    return workspaceConfig
  }
  if (existsSync(/* turbopackIgnore: true */ userConfig)) {
    return userConfig
  }
  for (const candidate of legacyConfigCandidates(env)) {
    if (existsSync(/* turbopackIgnore: true */ candidate)) {
      return candidate
    }
  }
  return userConfig
}

/**
 * 解析 workspace 级 Kodeks 配置目录（移植 resolve_kodeks_workspace_config_dir，config.py:92-98）。
 * KODEKS_WORKSPACE_ROOT 存在则用其（展开），否则用 cwd；再解析并附 .kodeks。
 */
export function resolveKodeksWorkspaceConfigDir(env: RuntimeEnv = processEnv()): string {
  const workspaceRoot = stringValue(envGet(env, 'KODEKS_WORKSPACE_ROOT'))
  const root =
    workspaceRoot !== undefined
      ? expanduser(workspaceRoot)
      : /* turbopackIgnore: true */ process.cwd()
  return resolveDir(root, CONFIG_DIR_NAME)
}

/**
 * 解析项目本地 `.env` 路径（移植 resolve_kodeks_dotenv_path，config.py:101-107）。
 */
export function resolveKodeksDotenvPath(env: RuntimeEnv = processEnv()): string {
  const workspaceRoot = stringValue(envGet(env, 'KODEKS_WORKSPACE_ROOT'))
  const root =
    workspaceRoot !== undefined
      ? expanduser(workspaceRoot)
      : /* turbopackIgnore: true */ process.cwd()
  return resolveDir(root, DOTENV_FILE_NAME)
}

/**
 * 返回平台相关的 legacy 配置候选（移植 _legacy_config_candidates，config.py:255-269）。
 */
function legacyConfigCandidates(env: RuntimeEnv): string[] {
  const system = platform()
  if (system === 'darwin') {
    return [
      joinPath(homeResolver(), 'Library', 'Application Support', 'kodeks', CONFIG_FILE_NAME),
    ]
  }
  if (system === 'win32') {
    // 复刻 Python `env.get("APPDATA") or str(home/AppData/Roaming)`：空串也回退。
    const appData = envGet(env, 'APPDATA') || joinPath(homeResolver(), 'AppData', 'Roaming')
    return [joinPath(appData, 'kodeks', CONFIG_FILE_NAME)]
  }
  const xdgHome = envGet(env, 'XDG_CONFIG_HOME') || joinPath(homeResolver(), '.config')
  return [joinPath(xdgHome, 'kodeks', CONFIG_FILE_NAME)]
}

// ── 公共加载入口（config.py:110-154）──────────────────────────────────────

/**
 * 加载配置文件为 env-style 值，进程 env 始终优先（移植 load_model_runtime_env，config.py:110-121）。
 * @param env 运行时 env（默认 process.env）。
 * @param requestedModelRef 请求的模型 ref。
 */
export function loadModelRuntimeEnv(
  env: RuntimeEnv = processEnv(),
  requestedModelRef: unknown = undefined,
): Record<string, string> {
  const runtimeEnv = loadDotenvRuntimeEnv(env)
  const values = readModelConfigEnv(runtimeEnv, requestedModelRef)
  for (const [key, value] of Object.entries(runtimeEnv)) {
    if (value !== null && value !== undefined) {
      values[key] = value
    }
  }
  applyRequestedDeepseekModel(values, requestedModelRef)
  return values
}

/**
 * 返回前端使用的无密钥 DeepSeek 模型目录（移植 load_configured_model_catalog，config.py:124-139）。
 */
export function loadConfiguredModelCatalog(
  env: RuntimeEnv = processEnv(),
): ConfiguredModelCatalog {
  const runtimeEnv = loadDotenvRuntimeEnv(env)
  const path = resolveKodeksConfigPath(runtimeEnv)
  if (!existsSync(/* turbopackIgnore: true */ path)) {
    return withDefaultModelCatalog({ primary: null, models: [] }, runtimeEnv)
  }
  const config = resolveConfigEnvVars(parseConfigFile(path), runtimeEnv) as Record<string, unknown>
  return withDefaultModelCatalog(
    { primary: null, models: configuredDeepseekModels(config) },
    runtimeEnv,
  )
}

/**
 * 解析当前模型 provider 选项（不构造客户端）（移植 resolve_model_client_options，config.py:142-154）。
 */
export function resolveModelClientOptions(
  env: RuntimeEnv = processEnv(),
  requestedReasoningEffort: unknown = undefined,
  requestedProvider: unknown = undefined,
): Record<string, unknown> | null {
  const runtimeEnv = loadDotenvRuntimeEnv(env)
  return resolveModelClientOptionsFromEnv(runtimeEnv, requestedReasoningEffort, requestedProvider)
}

// ── 内部辅助（config.py:157-283）──────────────────────────────────────────

/**
 * 从配置文件读取 env-style 模型配置（移植 _read_model_config_env，config.py:157-164）。
 */
function readModelConfigEnv(
  env: RuntimeEnv,
  requestedModelRef: unknown,
): Record<string, string> {
  const path = resolveKodeksConfigPath(env)
  if (!existsSync(/* turbopackIgnore: true */ path)) {
    return {}
  }
  const config = resolveConfigEnvVars(parseConfigFile(path), env) as Record<string, unknown>
  return modelConfigToEnv(config, requestedModelRef)
}

/** 同步读取并 JSON 解析配置文件（复刻 Python `json.loads(path.read_text())`）。 */
function parseConfigFile(path: string): unknown {
  return JSON.parse(readFileSync(/* turbopackIgnore: true */ path, 'utf-8'))
}

/**
 * 把请求的 `deepseek/<model>` ref 应用到纯 env 配置（移植 _apply_requested_deepseek_model，config.py:167-176）。
 */
function applyRequestedDeepseekModel(
  values: Record<string, string>,
  requestedModelRef: unknown,
): void {
  const requested = splitDeepseekModelRef(stringValue(requestedModelRef))
  if (requested === undefined) {
    return
  }
  values.KODEKS_MODEL_PROVIDER = 'moonbridge'
  values.KODEKS_CHAT_COMPLETIONS_MODEL = requested
}

/**
 * 从 DeepSeek 模型 ref 返回模型 id（移植 _split_deepseek_model_ref，config.py:179-185）。
 * 仅 provider==deepseek 且 model 非空时返回 model，否则 undefined。
 */
function splitDeepseekModelRef(value: string | undefined): string | undefined {
  if (value === undefined || !value.includes('/')) {
    return undefined
  }
  const index = value.indexOf('/')
  const provider = value.slice(0, index)
  const model = value.slice(index + 1)
  return provider === 'deepseek' && model ? model : undefined
}

/**
 * 合并项目本地 `.env` 值而不覆盖显式 env（移植 _load_dotenv_runtime_env，config.py:188-200）。
 * 仅当 env 是“进程 env”或显式提供了 KODEKS_WORKSPACE_ROOT 时才读 workspace .env；
 * 显式 env 覆盖 dotenv。
 */
function loadDotenvRuntimeEnv(env: RuntimeEnv): Record<string, string | null | undefined> {
  const values = normalizeModelEnvAliases({ ...env })
  // 复刻 Python `env is not os.environ and "KODEKS_WORKSPACE_ROOT" not in values`：
  // 仅当不是进程 env 且未显式提供 workspace root 时跳过 dotenv。
  if (!isProcessEnv(env) && !('KODEKS_WORKSPACE_ROOT' in values)) {
    return values
  }
  const path = resolveKodeksDotenvPath(values)
  if (!existsSync(/* turbopackIgnore: true */ path)) {
    return values
  }
  const dotenvValues = normalizeModelEnvAliases(readDotenvFile(path))
  const merged: Record<string, string | null | undefined> = { ...dotenvValues }
  // 显式 env 覆盖 dotenv（复刻 Python `merged.update(values)`）。
  Object.assign(merged, values)
  return merged
}

/**
 * 把友好模型 env 别名复制进 canonical 运行时名（移植 _normalize_model_env_aliases，config.py:203-214）。
 * 仅当 canonical 未设置（_string_value 为 undefined）时才填充。
 */
function normalizeModelEnvAliases(
  env: Record<string, string | null | undefined>,
): Record<string, string | null | undefined> {
  const normalized = { ...env }
  for (const [alias, canonical] of Object.entries(MODEL_ENV_ALIASES)) {
    if (stringValue(normalized[canonical]) === undefined) {
      const aliasValue = stringValue(normalized[alias])
      if (aliasValue !== undefined) {
        normalized[canonical] = aliasValue
      }
    }
  }
  return normalized
}

/**
 * 从 UTF-8 文件读取简单 dotenv 赋值（移植 _read_dotenv_file，config.py:217-227）。
 */
function readDotenvFile(path: string): Record<string, string> {
  const values: Record<string, string> = {}
  const text = readFileSync(/* turbopackIgnore: true */ path, 'utf-8')
  for (const rawLine of splitLines(text)) {
    const parsed = parseDotenvLine(rawLine)
    if (parsed === undefined) {
      continue
    }
    const [key, value] = parsed
    values[key] = value
  }
  return values
}

/**
 * 复刻 Python `str.splitlines()`：按通用换行符切分，且不保留尾随空行（与 splitlines 行为一致）。
 * 仅需覆盖 dotenv 实际用到的 \n / \r\n / \r。
 */
function splitLines(text: string): string[] {
  if (text === '') {
    return []
  }
  // 去掉末尾恰好一个换行（splitlines 不会因末尾换行产生额外空字符串）。
  const normalized = text.replace(/(\r\n|\r|\n)$/, '')
  return normalized.split(/\r\n|\r|\n/)
}

/**
 * 把一行 dotenv 解析为键值对（移植 _parse_dotenv_line，config.py:230-244）。
 * 支持 `export ` 前缀、`#` 行注释、`key=value`；非法 key 跳过。
 */
function parseDotenvLine(line: string): [string, string] | undefined {
  let stripped = line.trim()
  if (!stripped || stripped.startsWith('#')) {
    return undefined
  }
  if (stripped.startsWith('export ')) {
    // 复刻 Python `stripped[7:].lstrip()`：去掉 'export ' 后再去左侧空白。
    stripped = stripped.slice(7).replace(/^\s+/, '')
  }
  const eqIndex = stripped.indexOf('=')
  if (eqIndex === -1) {
    return undefined
  }
  const key = stripped.slice(0, eqIndex).trim()
  const rawValue = stripped.slice(eqIndex + 1)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    return undefined
  }
  return [key, parseDotenvValue(rawValue.trim())]
}

/**
 * 解析 dotenv 值，带轻量引号与注释处理（移植 _parse_dotenv_value，config.py:247-252）。
 * 同引号包裹则去引号；否则按首个 ` #` 截断行内注释再 strip。
 */
function parseDotenvValue(value: string): string {
  if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === "'" || value[0] === '"')) {
    return value.slice(1, -1)
  }
  // 复刻 Python `value.split(" #", 1)[0].strip()`：按首个 ' #' 分割取左段再 strip。
  const idx = value.indexOf(' #')
  const head = idx === -1 ? value : value.slice(0, idx)
  return head.trim()
}

/**
 * 递归展开配置中的 `${VAR}`（移植 _resolve_config_env_vars，config.py:272-283）。
 * 字符串：把 `${VAR}` 替换为 env 值，缺失时保留原样 `${VAR}`；列表/对象递归；其它原样返回。
 */
function resolveConfigEnvVars(value: unknown, env: RuntimeEnv): unknown {
  if (typeof value === 'string') {
    // Python 正则 `\$\{([A-Z_][A-Z0-9_]*)\}`：大写键名；缺失或空值（or）回退原样。
    return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (whole, name: string) => {
      const replacement = envGet(env, name)
      // 复刻 Python `env.get(name) or match.group(0)`：None/'' 皆回退原始 `${VAR}`。
      return replacement || whole
    })
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolveConfigEnvVars(item, env))
  }
  if (isDict(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) {
      result[key] = resolveConfigEnvVars(item, env)
    }
    return result
  }
  return value
}

// ── 进程 env 语义（复刻 Python `env is os.environ` 判定）──────────────────

/**
 * 返回当前进程 env 的 RuntimeEnv 视图（复刻 Python 默认 `os.environ`）。
 * 直接返回 process.env 引用本身，以便 isProcessEnv 用引用相等判定。
 */
function processEnv(): RuntimeEnv {
  return process.env as RuntimeEnv
}

/**
 * 复刻 Python `env is os.environ`：用引用相等判断 env 是否为进程 env。
 * 仅当调用方传入 process.env 本体（或未传、走 processEnv 默认）时为真。
 */
function isProcessEnv(env: RuntimeEnv): boolean {
  return (env as unknown) === (process.env as unknown)
}
