#!/usr/bin/env node
// Main gateway entry point.
// Starts:
//   1. HTTP server (OpenAI-compatible /v1 endpoint)
//   2. Health monitor loop
//   3. Bansos discovery loop (optional, needs TELEGRAM_BOT_TOKEN)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb, getQuotaToday, getAllProviders } from './database.js';
import { registerProvider, listProviders } from './provider-registry.js';
import { startHealthMonitor, checkAllProviders } from './health-monitor.js';
import { forwardChat, openUpstreamStream } from './router.js';
import { seedFromEnv } from './seed.js';
import {
  anthropicToChatReq,
  openaiToAnthropic,
  anthropicError,
  startAnthropicStream,
} from './anthropic-bridge.js';
import { initCache, cacheStats } from './cache.js';
import { startCatalogRefresh } from './catalog-refresh.js';
import { startDiscovery } from './discovery.js';

initDb();
initCache();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const PORT = parseInt(process.env.GATEWAY_PORT || '8080', 10);
const HOST = process.env.GATEWAY_HOST || '127.0.0.1';
const GATEWAY_API_KEY = process.env.GATEWAY_API_KEY || '';

// --- Simple bearer auth ---
function auth(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (!GATEWAY_API_KEY) return next();
  const header = req.headers['authorization'] ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (token !== GATEWAY_API_KEY && token !== GATEWAY_API_KEY) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  }
  next();
}

// --- OpenAI-compatible endpoints ---

app.get('/v1/models', auth, (_req, res) => {
  const providers = getAllProviders().filter((p) => p.enabled);
  const models = providers.flatMap((p) =>
    (p.models.length ? p.models : ['auto']).map((m) => ({
      id: m,
      object: 'model',
      owned_by: p.name,
    }))
  );
  res.json({ object: 'list', data: models });
});

app.post('/v1/chat/completions', auth, async (req, res) => {
  const { model = 'auto', messages, max_tokens, temperature, stream } = req.body ?? {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: { message: 'messages is required', type: 'invalid_request_error' } });
  }
  if (stream) {
    // Real streaming: pipe upstream SSE through to the client
    try {
      const upstream = await openUpstreamStream({ model, messages, maxTokens: max_tokens, temperature });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      // First chunk announces role
      res.write(`data: ${JSON.stringify({
        id: upstream.id,
        object: 'chat.completion.chunk',
        model,
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      })}\n\n`);

      let buffer = '';
      upstream.stream.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            res.write('data: [DONE]\n\n');
            continue;
          }
          try {
            const parsed = JSON.parse(data);
            // Normalize: re-tag id/model, keep upstream deltas
            parsed.id = parsed.id ?? upstream.id;
            parsed.model = parsed.model ?? model;
            res.write(`data: ${JSON.stringify(parsed)}\n\n`);
          } catch {
            // ignore malformed lines
          }
        }
      });
      upstream.stream.on('end', () => res.end());
      upstream.stream.on('error', () => {
        res.write('data: [DONE]\n\n');
        res.end();
      });
    } catch (err: any) {
      res.status(err.statusCode ?? 500).json({ error: { message: err.message, type: 'gateway_error' } });
    }
    return;
  }

  try {
    const result = await forwardChat({ model, messages, maxTokens: max_tokens, temperature });
    const hasToolCalls = Array.isArray(result.toolCalls) && result.toolCalls.length > 0;
    res.json({
      id: result.id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: result.model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: result.content,
            ...(hasToolCalls ? {
              tool_calls: result.toolCalls!.map((tc) => ({
                id: tc.id,
                type: 'function',
                function: { name: tc.name, arguments: tc.arguments },
              })),
            } : {}),
          },
          finish_reason: hasToolCalls ? 'tool_calls' : 'stop',
        },
      ],
      usage: {
        prompt_tokens: 0,
        completion_tokens: result.tokensUsed,
        total_tokens: result.tokensUsed,
      },
      // gateway-specific extras
      gateway: { provider: result.provider, latency_ms: result.latencyMs, from_cache: result.fromCache },
    });
  } catch (err: any) {
    res.status(err.statusCode ?? 500).json({ error: { message: err.message, type: 'gateway_error' } });
  }
});

// --- Anthropic-compatible endpoint (for Claude Code etc.) ---

app.post('/v1/messages', auth, async (req, res) => {
  const body = req.body ?? {};
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return anthropicError(res, 400, 'messages is required');
  }
  const chatReq = anthropicToChatReq(body);
  const model = chatReq.model;

  if (chatReq.stream) {
    try {
      const upstream = await openUpstreamStream(chatReq);
      startAnthropicStream(res, upstream.stream, upstream.id, model);
    } catch (err: any) {
      anthropicError(res, err.statusCode ?? 500, err.message);
    }
    return;
  }

  try {
    const result = await forwardChat(chatReq);
    res.json(openaiToAnthropic(result));
  } catch (err: any) {
    anthropicError(res, err.statusCode ?? 500, err.message);
  }
});

// Anthropic SDK also probes count_tokens
app.post('/v1/messages/count_tokens', auth, (_req, res) => {
  res.json({ input_tokens: 0 });
});

// --- Admin endpoints ---

app.get('/admin/status', auth, (_req, res) => {
  const providers = listProviders().map((p) => ({
    name: p.name,
    baseUrl: p.baseUrl,
    type: p.type,
    status: p.status,
    priority: p.priority,
    enabled: p.enabled,
    cooldownUntil: p.cooldownUntil > Date.now() ? new Date(p.cooldownUntil).toISOString() : null,
    models: p.models.length,
  }));
  res.json({ providers });
});

app.post('/admin/providers', auth, (req, res) => {
  const { name, baseUrl, apiKey = '', models = [], priority = 100, type = 'bansos', protocol = 'openai' } = req.body ?? {};
  if (!name || !baseUrl) {
    return res.status(400).json({ error: 'name and baseUrl are required' });
  }
  const p = registerProvider({ name, baseUrl, apiKey, models, priority, type: type as any, protocol: protocol as any });
  res.json({ ok: true, provider: { name: p.name, id: p.id } });
});

app.post('/admin/health-check', auth, async (_req, res) => {
  const results = await checkAllProviders();
  res.json({ results });
});

app.get('/admin/quota/:provider/:model', auth, (req, res) => {
  const usage = getQuotaToday(req.params.provider, req.params.model);
  res.json({ usage: usage ?? null });
});

app.get('/admin/cache-stats', auth, (_req, res) => {
  res.json(cacheStats());
});

// --- Boot ---

async function main() {
  seedFromEnv();
  startHealthMonitor();
  startCatalogRefresh();
  if (process.env.TELEGRAM_BOT_TOKEN) {
    startDiscovery();
  }

  // Initial health check in background
  checkAllProviders().catch((e) => console.error('[boot] initial health check failed:', e.message));

  app.listen(PORT, HOST, () => {
    console.log(`[gateway] Free AI Gateway listening on http://${HOST}:${PORT}/v1`);
    console.log(`[gateway] Point your client: base_url=http://${HOST}:${PORT}/v1`);
  });
}

main().catch((err) => {
  console.error('[gateway] Fatal:', err);
  process.exit(1);
});
