// frontend/lib/server/routes/models.ts
// Models 路由逻辑（移植 app.py 的 /api/models）：返回无密钥模型目录。
// Python 用 model_dump(by_alias=True, exclude_none=True)：baseURL/primary 为 None 时**省略该键**（保真风险 4, 8）。
// TS 目录已是 camelCase（≈by_alias）；这里复刻 exclude_none：把 null/undefined 的 baseURL/primary 整键丢弃。
import { NextResponse } from 'next/server'
import { loadConfiguredModelCatalog } from '../config'
import type {
  ConfiguredModelCatalog,
  ConfiguredModelOption,
  RuntimeEnv,
} from '../model-config'

/**
 * 把单个模型 option 序列化为 wire 形状，复刻 exclude_none：baseURL 为 null/undefined 时省略键。
 * 键顺序对齐 contracts.py 字段顺序（保真风险 7）。
 */
function dumpOption(option: ConfiguredModelOption): Record<string, unknown> {
  const dump: Record<string, unknown> = {
    ref: option.ref,
    providerId: option.providerId,
    providerName: option.providerName,
    modelId: option.modelId,
    modelName: option.modelName,
    api: option.api,
    requiresBridge: option.requiresBridge,
  }
  if (option.baseURL !== null && option.baseURL !== undefined) {
    dump.baseURL = option.baseURL
  }
  dump.configured = option.configured
  return dump
}

/**
 * 复刻 catalog.model_dump(by_alias=True, exclude_none=True)：primary 为 null/undefined 时省略键。
 */
function dumpCatalog(catalog: ConfiguredModelCatalog): Record<string, unknown> {
  const dump: Record<string, unknown> = {}
  if (catalog.primary !== null && catalog.primary !== undefined) {
    dump.primary = catalog.primary
  }
  dump.models = catalog.models.map(dumpOption)
  return dump
}

/**
 * 返回配置好的模型目录（移植 models，app.py:90-95）。
 * @returns 200 catalog（by_alias + exclude_none）。
 */
export function modelsCatalog(env: RuntimeEnv): NextResponse {
  const catalog = loadConfiguredModelCatalog(env)
  return NextResponse.json(dumpCatalog(catalog))
}
