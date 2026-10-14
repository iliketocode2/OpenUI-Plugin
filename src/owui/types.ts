export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ImagePart {
  type: 'image_url';
  image_url: { url: string };
}

export type ContentPart = TextPart | ImagePart;

export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface WireMessage {
  role: Role;
  content: string | ContentPart[] | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface AssembledToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AssistantTurn {
  content: string;
  reasoning: string;
  toolCalls: AssembledToolCall[];
  finishReason: string | null;
  usage: Usage | null;
}

export interface ChatRequest {
  model: string;
  messages: WireMessage[];
  tools?: ToolDefinition[];
  stop?: string[];
  temperature?: number;
}
