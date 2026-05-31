import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  fetchDeepSeekStream,
  fromDeepSeekStream,
  toDeepSeekChatRequest,
} from "./chat-completions/deepseek";
import { toCoreRequest } from "./responses-core";
import { toSseFrame } from "./sse";
import type { ResponsesBridgeOptions, ResponsesRequest } from "./types";

const DEFAULT_MODEL_ALIASES = ["bridge", "moonbridge"];

// 创建一个 Node HTTP server，用 OpenAI Responses 入口转发到 Chat Completions。
export function createBridgeServer(options: ResponsesBridgeOptions = {}) {
  return createServer((request, response) => {
    void handleBridgeRequest(request, response, options);
  });
}

// 处理 bridge 的 HTTP routes，并保持 OpenAI-compatible JSON/SSE 形态。
async function handleBridgeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResponsesBridgeOptions,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  if (request.method === "GET" && path === "/health") {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (
    request.method === "GET" &&
    (path === "/models" || path === "/v1/models")
  ) {
    const models = listModels(options);
    writeJson(response, 200, { object: "list", data: models, models });
    return;
  }

  if (
    request.method === "POST" &&
    (path === "/responses" || path === "/v1/responses")
  ) {
    await handleResponses(request, response, options);
    return;
  }

  writeJson(response, 404, { error: { message: "Not found." } });
}

// 执行一次 Responses 请求转发，并把上游 Chat Completions SSE 流写回客户端。
async function handleResponses(
  request: IncomingMessage,
  response: ServerResponse,
  options: ResponsesBridgeOptions,
): Promise<void> {
  const apiKey = options.chatCompletionsApiKey;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    writeJson(response, 500, {
      error: {
        message:
          "KODEKS_CHAT_COMPLETIONS_API_KEY is required. Legacy DEEPSEEK_* and KODEKS_BRIDGE_DEEPSEEK_* keys have been removed.",
      },
    });
    return;
  }

  const body = (await readJsonBody(request)) as ResponsesRequest;
  const coreRequest = toCoreRequest(body);
  const upstreamModel = options.chatCompletionsModel;
  if (upstreamModel === undefined || upstreamModel.trim().length === 0) {
    writeJson(response, 500, {
      error: {
        message:
          "KODEKS_CHAT_COMPLETIONS_MODEL is required. Legacy DEEPSEEK_* and KODEKS_BRIDGE_DEEPSEEK_* keys have been removed.",
      },
    });
    return;
  }

  const deepSeekRequest = toDeepSeekChatRequest(coreRequest, {
    model: upstreamModel,
  });
  const upstream = await fetchDeepSeekStream(deepSeekRequest, apiKey, options);

  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
  });
  for await (const event of fromDeepSeekStream(upstream, {
    model: coreRequest.model,
  })) {
    response.write(toSseFrame(event));
  }
  response.write("data: [DONE]\n\n");
  response.end();
}

// 读取 HTTP JSON body。
async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// 写出 JSON 响应。
function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(payload));
}

// 列出 bridge 暴露的模型别名。
function listModels(
  options: ResponsesBridgeOptions,
): Array<Record<string, string>> {
  return (options.modelAliases ?? DEFAULT_MODEL_ALIASES).map((model) => ({
    id: model,
    object: "model",
    owned_by: "kodeks",
  }));
}
