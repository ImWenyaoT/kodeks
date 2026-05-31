import type { CoreMessage, CoreRequest, ResponsesRequest } from "./types";

// 把 OpenAI Responses 请求转换成协议无关 Core IR。
export function toCoreRequest(request: ResponsesRequest): CoreRequest {
  const messages: CoreMessage[] = [];
  if (request.instructions !== undefined && request.instructions.length > 0) {
    messages.push({ role: "system", content: request.instructions });
  }

  for (const item of normalizeInputItems(request.input)) {
    const message = toCoreMessage(item);
    if (message !== null) {
      messages.push(message);
    }
  }

  return {
    model: request.model,
    instructions: request.instructions,
    messages,
    tools: (request.tools ?? [])
      .filter((tool) => tool.type === "function")
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.parameters ?? {},
      })),
    reasoningEffort: request.reasoning?.effort ?? "high",
    stream: request.stream !== false,
  };
}

// 把 Responses input 的 string 或数组形态统一成数组。
function normalizeInputItems(input: unknown): unknown[] {
  if (typeof input === "string") {
    return [
      {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: input }],
      },
    ];
  }

  return Array.isArray(input) ? input : [];
}

// 把单个 Responses input item 转换成 Core message。
function toCoreMessage(item: unknown): CoreMessage | null {
  if (!isRecord(item)) {
    return null;
  }

  if (item.type === "function_call") {
    return {
      role: "assistant",
      content: "",
      reasoningContent: readString(item.reasoning_content),
      toolCalls: [
        {
          id: readString(item.call_id) ?? readString(item.id) ?? "",
          name: readString(item.name) ?? "",
          argumentsText: readString(item.arguments) ?? "{}",
        },
      ],
    };
  }

  if (item.type === "function_call_output") {
    return {
      role: "tool",
      content: readString(item.output) ?? "",
      toolCallId: readString(item.call_id) ?? "",
    };
  }

  const role = readCoreRole(item.role);
  if (role === null) {
    return null;
  }

  return {
    role,
    content: readContentText(item.content),
  };
}

// 从 mixed content blocks 中抽取文本。
function readContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!isRecord(block)) {
        return "";
      }
      return (
        readString(block.text) ??
        readString(block.output_text) ??
        readString(block.input_text) ??
        ""
      );
    })
    .join("");
}

// 读取 Core 支持的 role。
function readCoreRole(value: unknown): CoreMessage["role"] | null {
  if (
    value === "system" ||
    value === "user" ||
    value === "assistant" ||
    value === "tool"
  ) {
    return value;
  }
  return null;
}

// 判断 unknown 是否是普通 record。
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// 安全读取 string 字段。
function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
