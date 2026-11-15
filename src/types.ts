// Core type definitions for Free AI Token Gateway

export type ProviderStatus = 'healthy' | 'rate_limited' | 'invalid' | 'error' | 'timeout' | 'cooldown';

export type ProviderType = 'official' | 'gateway' | 'keyless' | 'bansos';

export type Protocol = 'openai' | 'anthropic' | 'gemini';

export interface Provider {
  id: string;
  name: string;
  baseUrl: string;
  chatEndpoint?: string; // full chat URL override (default: baseUrl + /chat/completions)
  apiKey: string;
  type: ProviderType;
  protocol: Protocol;
  status: ProviderStatus;
  cooldownUntil: number; // timestamp
  lastProbe: number; // timestamp
  models: string[];
  rateLimits: {
    rpm: number; // requests per minute
    rpd: number; // requests per day
    tpm: number; // tokens per minute
    tpd: number; // tokens per day
  };
  priority: number; // lower = higher priority
  enabled: boolean;
  isFree: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderConfig {
  name: string;
  baseUrl: string;
  chatEndpoint?: string;
  apiKey: string;
  type?: ProviderType;
  protocol?: Protocol;
  models?: string[];
  rateLimits?: Partial<Provider['rateLimits']>;
  priority?: number;
  isFree?: boolean;
}

export interface FunctionToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string; // JSON string
  };
}

export interface ChatMessage {
  role: string;
  content: string;
  tool_calls?: FunctionToolCall[]; // assistant messages requesting tool execution
  tool_call_id?: string; // role 'tool' messages: id of the tool_use being answered
  name?: string; // role 'tool' messages: tool name
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  tools?: Array<Record<string, unknown>>;
}

export interface ResponseToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ChatResponse {
  id: string;
  model: string;
  content: string;
  provider: string;
  latencyMs: number;
  tokensUsed: number;
  fromCache: boolean;
  toolCalls?: ResponseToolCall[];
}

export interface QuotaUsage {
  providerId: string;
  model: string;
  requestCount: number;
  tokenInput: number;
  tokenOutput: number;
  date: string; // YYYY-MM-DD
}

export interface RequestLog {
  id: string;
  timestamp: number;
  providerId: string;
  model: string;
  status: number;
  latencyMs: number;
  tokensUsed: number;
  fallbackCount: number;
  error?: string;
}

export interface BansosEntry {
  source: string; // telegram, github, threads, etc.
  url: string;
  apiKey: string;
  models: string[];
  discoveredAt: number;
  expiresAt?: number;
  status: 'pending' | 'valid' | 'invalid' | 'expired';
}

export interface GatewayStats {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  avgLatencyMs: number;
  providerStats: Record<string, {
    requests: number;
    success: number;
    failed: number;
    avgLatency: number;
  }>;
  quotaUsage: QuotaUsage[];
}