export interface VapiCallCustomer {
  number?: string;
}

export interface VapiCall {
  id: string;
  customer?: VapiCallCustomer;
}

export interface VapiFunctionCall {
  name: string;
  parameters: Record<string, unknown>;
}

export interface VapiArtifact {
  messages?: Array<{ role: string; content: string }>;
  transcript?: string;
  recordingUrl?: string;
}

export interface VapiAnalysis {
  summary?: string;
  successEvaluation?: string;
}

export type VapiMessageType =
  | 'assistant-request'
  | 'call-start'
  | 'end-of-call-report'
  | 'function-call'
  | string;

export interface VapiMessage {
  type: VapiMessageType;
  call?: VapiCall;
  functionCall?: VapiFunctionCall;
  artifact?: VapiArtifact;
  analysis?: VapiAnalysis;
}

export interface VapiWebhookPayload {
  message: VapiMessage;
}

export interface AssistantVoice {
  provider: 'playht' | 'azure' | 'elevenlabs' | 'openai';
  voiceId: string;
}

export interface AssistantModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface AssistantToolParameter {
  type: string;
  description?: string;
  enum?: string[];
}

export interface AssistantToolFunction {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, AssistantToolParameter>;
    required?: string[];
  };
}

export interface AssistantTool {
  type: 'function';
  function: AssistantToolFunction;
}

export interface AssistantModel {
  provider: 'anthropic' | 'openai';
  model: string;
  messages: AssistantModelMessage[];
  tools?: AssistantTool[];
}

export interface AssistantServerConfig {
  url: string;
  secret?: string;
}

export interface AssistantConfig {
  name: string;
  firstMessage: string;
  model: AssistantModel;
  voice: AssistantVoice;
  serverUrl?: string;
  server?: AssistantServerConfig;
  maxDurationSeconds: number;
  silenceTimeoutSeconds: number;
  endCallMessage?: string;
  endCallFunctionEnabled?: boolean;
  backgroundDenoisingEnabled?: boolean;
}

export interface AssistantRequestResponse {
  assistant: AssistantConfig;
}
