import { randomUUID } from 'crypto';
import axios from 'axios';
import type { AxiosResponse } from 'axios';
import type { Provider, ChatRequest, ChatResponse } from './types.js';
import { getAvailableProviders, updateProviderStatus } from './provider-registry.js';
import { incrementQuota, logRequest } from './database.js';
import { cacheLookup, cacheStore } from './cache.js';
import { compressMessages } from './compress.js';

const MAX_FALLBACK_ATTEMPTS = 20;
const REQUEST_TIMEOUT_MS = 120000;

interface ProviderAttempt {
  provider: Provider;
  status: number;
  error?: string;
}

// Key rotation: apiKey column may hold "key1,key2,key3"
export function getKeys(provider: Provider): string[] {
  if (!provider.apiKey) return [''];
  const keys = provider.apiKey.split(',').map((k) => k.trim()).filter(Boolean);
  return keys.length > 0 ? keys : [''];
}

function authHeader(key: string): Record<string, string> {
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export function selectProviders(model: string): Provider[] {
  const available = getAvailableProviders();

  if (model && model !== 'auto') {
    // Prefer providers that explicitly list the model
    const exact = available.filter((p) => p.models.includes(model));
    if (exact.length > 0) return exact;
  }

  // Otherwise: priority order (lower number = higher priority)
  return available;
}

function payloadFor(provider: Provider, req: ChatRequest, stream: boolean): Record<string, unknown> {
  return {
    model: req.model === 'auto' ? pickModelForProvider(provider) : req.model,
    messages: req.messages,
    max_tokens: req.maxTokens,
    temperature: req.temperature,
    stream,
    ...(req.tools ? { tools: req.tools } : {}),
  };
}

function handleFailure(provider: Provider, status: number, attempts: ProviderAttempt[]): void {
  attempts.push({ provider, status, error: undefined });
  // 429 = rate limited; if provider has more keys, rotate quickly (short cooldown)
  if (status === 429) {
    const keys = getKeys(provider);
    const cooldown = keys.length > 1 ? 15000 : 300000; // 15s to try next key, else 5min
    updateProviderStatus(provider.name, 'rate_limited', cooldown);
  } else if (status === 401 || status === 403) {
    updateProviderStatus(provider.name, 'invalid', 3600000);
  }
}

// ---------- Non-streaming ----------

export async function forwardChat(req: ChatRequest): Promise<ChatResponse> {
  // Compress long contexts first so equivalent oversized requests dedupe to the same cache key
  const compressed: ChatRequest = { ...req, messages: compressMessages(req.messages) };

  // Prompt cache: exact → normalized → trigram fuzzy
  const cached = cacheLookup(compressed.model, compressed.messages);
  if (cached.hit) {
    const response: ChatResponse = {
      id: randomUUID(),
      model: compressed.model,
      content: cached.response ?? '',
      provider: cached.provider ?? 'cache',
      latencyMs: 0,
      tokensUsed: 0,
      fromCache: true,
    };
    logRequest({
      id: response.id,
      timestamp: Date.now(),
      providerId: 'cache',
      model: compressed.model,
      status: 200,
      latencyMs: 0,
      tokensUsed: 0,
      fallbackCount: 0,
    });
    return response;
  }

  const candidates = selectProviders(compressed.model);
  const attempts: ProviderAttempt[] = [];

  if (candidates.length === 0) {
    throw Object.assign(new Error('No available providers'), { statusCode: 503 });
  }

  let fallbackCount = 0;
  for (const provider of candidates) {
    if (fallbackCount >= MAX_FALLBACK_ATTEMPTS) break;

    const started = Date.now();
    try {
      const url = provider.chatEndpoint ?? `${provider.baseUrl}/chat/completions`;

      // Key rotation: try each key for this provider
      for (const key of getKeys(provider)) {
        const resp = await axios.post(
          url,
          payloadFor(provider, compressed, false),
          {
            headers: { 'Content-Type': 'application/json', ...authHeader(key) },
            timeout: REQUEST_TIMEOUT_MS,
            validateStatus: () => true,
          }
        );

        if (resp.status === 200 && resp.data?.choices?.[0]?.message) {
          const message = resp.data.choices[0].message;
          const content = message.content ?? '';
          const rawToolCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
          const toolCalls: ChatResponse['toolCalls'] = rawToolCalls.map((tc) => ({
            id: typeof tc?.id === 'string' ? tc.id : '',
            name: typeof tc?.function?.name === 'string' ? tc.function.name : '',
            arguments: typeof tc?.function?.arguments === 'string' ? tc.function.arguments : '',
          }));
          const tokens =
            resp.data.usage?.total_tokens ??
            Math.ceil(content.length / 4);
          const latencyMs = Date.now() - started;

          incrementQuota(provider.id, compressed.model, resp.data.usage?.prompt_tokens ?? 0, resp.data.usage?.completion_tokens ?? tokens);
          logRequest({
            id: randomUUID(),
            timestamp: Date.now(),
            providerId: provider.id,
            model: compressed.model,
            status: 200,
            latencyMs,
            tokensUsed: tokens,
            fallbackCount,
          });

          if (!compressed.tools && toolCalls.length === 0 && content.length > 0) {
            cacheStore(compressed.model, compressed.messages, content, provider.name);
          }

          return {
            id: resp.data.id ?? randomUUID(),
            model: compressed.model,
            content,
            provider: provider.name,
            latencyMs,
            tokensUsed: tokens,
            fromCache: false,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          };
        }

        handleFailure(provider, resp.status, attempts);
        fallbackCount++;

        // 429 with more keys available: try next key immediately
        if (resp.status === 429 && key !== getKeys(provider)[getKeys(provider).length - 1]) {
          continue;
        }
        break; // other statuses or last key: move to next provider
      }
    } catch (err: any) {
      attempts.push({ provider, status: 0, error: err.message });
      fallbackCount++;
    }
  }

  logRequest({
    id: randomUUID(),
    timestamp: Date.now(),
    providerId: 'none',
    model: req.model,
    status: 502,
    latencyMs: 0,
    tokensUsed: 0,
    fallbackCount,
    error: attempts.map((a) => `${a.provider.name}:${a.status}`).join(', '),
  });

  throw Object.assign(
    new Error(`All providers failed. Attempts: ${attempts.map((a) => `${a.provider.name}(${a.status})`).join(', ')}`),
    { statusCode: 502, attempts }
  );
}

// ---------- Streaming ----------

export interface UpstreamStream {
  provider: Provider;
  stream: NodeJS.ReadableStream;
  id: string;
  fallbackCount: number;
}

export async function openUpstreamStream(req: ChatRequest): Promise<UpstreamStream> {
  const candidates = selectProviders(req.model);
  const attempts: ProviderAttempt[] = [];

  if (candidates.length === 0) {
    throw Object.assign(new Error('No available providers'), { statusCode: 503 });
  }

  let fallbackCount = 0;
  for (const provider of candidates) {
    if (fallbackCount >= MAX_FALLBACK_ATTEMPTS) break;

    try {
      const url = provider.chatEndpoint ?? `${provider.baseUrl}/chat/completions`;

      for (const key of getKeys(provider)) {
        let resp: AxiosResponse;
        try {
          resp = await axios.post(
            url,
            payloadFor(provider, req, true),
            {
              headers: { 'Content-Type': 'application/json', ...authHeader(key) },
              timeout: REQUEST_TIMEOUT_MS,
              responseType: 'stream',
              validateStatus: () => true,
            }
          );
        } catch (err: any) {
          attempts.push({ provider, status: 0, error: err.message });
          fallbackCount++;
          break;
        }

        if (resp.status === 200) {
          return {
            provider,
            stream: resp.data as NodeJS.ReadableStream,
            id: randomUUID(),
            fallbackCount,
          };
        }

        // Non-200: consume body so socket is freed, then fail over
        resp.data?.destroy?.();
        handleFailure(provider, resp.status, attempts);
        fallbackCount++;

        if (resp.status === 429 && key !== getKeys(provider)[getKeys(provider).length - 1]) {
          continue; // rotate to next key
        }
        break; // next provider
      }
    } catch (err: any) {
      attempts.push({ provider, status: 0, error: err.message });
      fallbackCount++;
    }
  }

  logRequest({
    id: randomUUID(),
    timestamp: Date.now(),
    providerId: 'none',
    model: req.model,
    status: 502,
    latencyMs: 0,
    tokensUsed: 0,
    fallbackCount,
    error: attempts.map((a) => `${a.provider.name}:${a.status}`).join(', '),
  });

  throw Object.assign(
    new Error(`All providers failed. Attempts: ${attempts.map((a) => `${a.provider.name}(${a.status})`).join(', ')}`),
    { statusCode: 502, attempts }
  );
}

function pickModelForProvider(provider: Provider): string {
  return provider.models[0] ?? 'gpt-3.5-turbo';
}
