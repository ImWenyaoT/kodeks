export type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

export type ResponsesBridgeOptions = {
  chatCompletionsApiKey?: string;
  chatCompletionsBaseURL?: string;
  chatCompletionsModel?: string;
  modelAliases?: string[];
  userAgent?: string;
  fetch?: typeof fetch;
};

export type ResponsesRequest = {
  model: string;
  input: unknown;
  instructions?: string;
  tools?: ResponsesTool[];
  store?: boolean;
  reasoning?: {
    effort?: ReasoningEffort;
  };
  stream?: boolean;
};

export type ResponsesTool = {
  type: "function";
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
};

export type CoreRequest = {
  model: string;
  instructions?: string;
  messages: CoreMessage[];
  tools: CoreTool[];
  reasoningEffort: ReasoningEffort;
  stream: boolean;
};

export type CoreMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  reasoningContent?: string;
  toolCallId?: string;
  toolCalls?: CoreToolCall[];
};

export type CoreTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type CoreToolCall = {
  id: string;
  name: string;
  argumentsText: string;
};

export type DeepSeekChatRequest = {
  model: string;
  messages: DeepSeekChatMessage[];
  tools: DeepSeekChatTool[];
  thinking: {
    type: "enabled" | "disabled";
  };
  reasoning_effort?: "high" | "max";
  stream: true;
};

export type DeepSeekChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      reasoning_content?: string;
      tool_calls?: DeepSeekChatToolCall[];
    }
  | { role: "tool"; content: string; tool_call_id: string };

export type DeepSeekChatTool = {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
};

export type DeepSeekChatToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type ResponsesStreamEvent =
  | {
      type: "response.output_text.delta";
      delta: string;
      output_index: number;
      content_index: number;
      item_id: string;
    }
  | {
      type: "response.output_item.done";
      output_index: number;
      item: {
        id: string;
        type: "function_call";
        call_id: string;
        name: string;
        arguments: string;
        reasoning_content?: string;
        status: "completed";
      };
    }
  | {
      type: "response.completed";
      response: {
        id: string;
        model: string;
        status: "completed";
        output: unknown[];
      };
    }
  | {
      type: "response.failed";
      response: {
        id: string;
        model: string;
        status: "failed";
        error: {
          message: string;
        };
        output: unknown[];
      };
    }
  | {
      type: "error";
      message: string;
    };

export type DeepSeekStreamChunk = {
  id?: string;
  error?: { message?: string };
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: DeepSeekToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
};

export type DeepSeekToolCallDelta = {
  index?: number;
  id?: string;
  type?: "function";
  function?: {
    name?: string;
    arguments?: string;
  };
};
