// frontend/lib/server/routes/chat.ts
// Chat SSE 路由逻辑（移植 chat_routes.py）：把 runPythonChatTurn 的 runtime 事件流编码成 SSE 响应。
//  · createChatStreamResponse → /api/chat/stream：每个事件用 encodeSseFrame 原样输出（帧名取 event.type）。
//  · createChatUiResponse → /api/chat/ui：经 toUiTransportPayload 适配；null payload 静默丢弃不发帧（保真风险 1, 3）。
// 两端都用 ReadableStream + Content-Type: text/event-stream；chat 端点不发 [DONE]（保真风险 8）。
import {
  runPythonChatTurn,
  type ResponsesEventFactory,
} from '../agent'
import type { RuntimeEnv } from '../config'
import type { KodeksDatabase } from '../storage'
import { encodeSseFrame, toUiTransportPayload } from '../wire/events'
import { WorkspaceService } from '../workspace'

/** Chat 流响应构造参数（可注入 db/workspaceRoot/env/factory，便于单测 + oracle 重放）。 */
export interface ChatStreamArgs {
  /** 请求体（容错后的 dict）。 */
  body: Record<string, unknown>
  /** M2 存储门面单例。 */
  database: KodeksDatabase
  /** 授权工作区根。 */
  workspaceRoot: string
  /** 运行时 env（生产传 process.env）。 */
  env: RuntimeEnv
  /** 可选注入工厂（假模型）；不传走真实模型。 */
  factory?: ResponsesEventFactory | null
}

/** UTF-8 编码器（SSE 帧文本 → 字节）。 */
const encoder = new TextEncoder()

/**
 * 构造 /api/chat/stream 的 SSE 响应（移植 chat_stream + runtime_sse_frames，chat_routes.py:41-62）。
 * 每个 runtime 事件经 encodeSseFrame(String(event.type), event) 输出；不发 [DONE]。
 */
export function createChatStreamResponse(args: ChatStreamArgs): Response {
  const { body, database, workspaceRoot, env, factory = null } = args
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const runtimeBody = bodyWithServerSelectedFiles(body, workspaceRoot)
        for await (const event of runPythonChatTurn(runtimeBody, database, workspaceRoot, env, factory)) {
          const record = event as Record<string, unknown>
          controller.enqueue(encoder.encode(encodeSseFrame(String(record.type), record)))
        }
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * 构造 /api/chat/ui 的 SSE 响应（移植 chat_ui_stream + ui_sse_frames，chat_routes.py:47-69）。
 * 每个 runtime 事件经 toUiTransportPayload 适配；返回 null 的事件**不发任何帧**（保真风险 1, 3）。
 */
export function createChatUiResponse(args: ChatStreamArgs): Response {
  const { body, database, workspaceRoot, env, factory = null } = args
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const runtimeBody = bodyWithServerSelectedFiles(body, workspaceRoot)
        for await (const event of runPythonChatTurn(runtimeBody, database, workspaceRoot, env, factory)) {
          const payload = toUiTransportPayload(event as Record<string, unknown>)
          if (payload !== null) {
            controller.enqueue(encoder.encode(encodeSseFrame(String(payload.type), payload)))
          }
        }
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

/**
 * 将 route 请求体降权为服务端可信上下文：selected files 只接受路径，由 WorkspaceService 读取内容。
 */
function bodyWithServerSelectedFiles(
  body: Record<string, unknown>,
  workspaceRoot: string,
): Record<string, unknown> {
  const nextBody: Record<string, unknown> = { ...body }
  delete nextBody.instructions
  delete nextBody.provider
  const paths = selectedFilePaths(body)
  if (paths.length === 0) {
    delete nextBody.selectedFiles
    delete nextBody.selected_files
    return nextBody
  }
  const workspace = new WorkspaceService(workspaceRoot)
  nextBody.selectedFiles = paths.map((path) => {
    try {
      return { path, content: workspace.readFile(path), truncated: false }
    } catch (error) {
      return { path, error: errorMessage(error) }
    }
  })
  delete nextBody.selected_files
  return nextBody
}

/** 从 camelCase/snake_case 请求字段提取去重后的 selected-file 路径。 */
function selectedFilePaths(body: Record<string, unknown>): string[] {
  const raw = Array.isArray(body.selected_files) ? body.selected_files : body.selectedFiles
  if (!Array.isArray(raw)) {
    return []
  }
  const paths: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const path =
      typeof item === 'string'
        ? item.trim()
        : item !== null &&
            typeof item === 'object' &&
            !Array.isArray(item) &&
            typeof (item as { path?: unknown }).path === 'string'
          ? String((item as { path: string }).path).trim()
          : ''
    if (path && !seen.has(path)) {
      seen.add(path)
      paths.push(path)
    }
  }
  return paths
}

/** 把未知错误转成 route-safe message。 */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
