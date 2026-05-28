export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export type ChatToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

export type ChatMessage = {
  role: ChatRole;
  content: string;
  reasoningContent?: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ChatToolCall[];
};

export type ChatToolDefinition = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
};

export type ModelTurnRequest = {
  messages: ChatMessage[];
  tools: ChatToolDefinition[];
};

export type ModelTurnStreamEvent =
  | { type: 'text_delta'; text: string }
  | {
      type: 'tool_call';
      id: string;
      name: string;
      args: Record<string, unknown>;
      reasoningContent?: string;
    }
  | { type: 'response_completed'; responseId: string }
  | { type: 'error'; message: string };

export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

export type ModelProvider = 'openai' | 'bridge' | 'moonbridge' | 'deepseek';

export type ModelProviderOverride = ModelProvider;

export interface ModelClient {
  streamTurn(request: ModelTurnRequest): AsyncIterable<ModelTurnStreamEvent>;
}
