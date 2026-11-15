#!/usr/bin/env node
// MCP Server — exposes the free gateway as Model Context Protocol tools.
// Works with Claude Code, Kilo, Cursor, and any MCP client.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initDb } from './database.js';
import { listProviders, registerProvider, removeProvider } from './provider-registry.js';
import { forwardChat } from './router.js';
import { checkAllProviders } from './health-monitor.js';
import { getRecentLogs } from './database.js';

initDb();

const server = new McpServer({
  name: 'free-ai-gateway',
  version: '1.0.0',
});

server.tool(
  'ask_ai',
  'Send a prompt to the best available free AI model (auto failover across providers)',
  {
    prompt: z.string().describe('The prompt to send'),
    model: z.string().default('auto').describe('Model ID, or "auto" to let the router pick'),
    max_tokens: z.number().default(2000).describe('Max output tokens'),
  },
  async ({ prompt, model, max_tokens }) => {
    try {
      const result = await forwardChat({
        model,
        messages: [{ role: 'user', content: prompt }],
        maxTokens: max_tokens,
      });
      return {
        content: [
          { type: 'text' as const, text: result.content },
          { type: 'text' as const, text: `\n---\n[provider=${result.provider}, latency=${result.latencyMs}ms, tokens=${result.tokensUsed}]` },
        ],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'list_providers',
  'List all registered AI providers with health status and priorities',
  {},
  async () => {
    const providers = listProviders().map((p) => ({
      name: p.name,
      baseUrl: p.baseUrl,
      type: p.type,
      protocol: p.protocol,
      status: p.status,
      priority: p.priority,
      enabled: p.enabled,
      models: p.models.slice(0, 10),
      cooldownUntil: p.cooldownUntil > Date.now() ? new Date(p.cooldownUntil).toISOString() : null,
    }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(providers, null, 2) }] };
  }
);

server.tool(
  'add_provider',
  'Register a new AI provider (e.g. a new bansos gateway found on Telegram)',
  {
    name: z.string().describe('Unique provider name'),
    baseUrl: z.string().describe('API base URL (OpenAI-compatible)'),
    apiKey: z.string().describe('API key (empty string for keyless providers)'),
    models: z.array(z.string()).default([]).describe('Model IDs supported'),
    priority: z.number().default(100).describe('Lower = higher priority'),
  },
  async ({ name, baseUrl, apiKey, models, priority }) => {
    try {
      const p = registerProvider({ name, baseUrl, apiKey, models, priority, type: 'bansos' });
      return { content: [{ type: 'text' as const, text: `Provider "${p.name}" registered (id=${p.id})` }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  'remove_provider',
  'Remove a provider from the registry (e.g. an expired bansos)',
  { name: z.string().describe('Provider name to remove') },
  async ({ name }) => {
    const ok = removeProvider(name);
    return {
      content: [{ type: 'text' as const, text: ok ? `Provider "${name}" removed` : `Provider "${name}" not found` }],
    };
  }
);

server.tool(
  'check_health',
  'Probe all providers now and return health status',
  {},
  async () => {
    const results = await checkAllProviders();
    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  }
);

server.tool(
  'recent_logs',
  'Show recent request logs (routing decisions, failures, latency)',
  { limit: z.number().default(20).describe('Number of log entries') },
  async ({ limit }) => {
    const logs = getRecentLogs(limit);
    return { content: [{ type: 'text' as const, text: JSON.stringify(logs, null, 2) }] };
  }
);

const transport = new StdioServerTransport();
server.connect(transport).then(() => {
  console.error('[mcp-server] free-ai-gateway MCP server running on stdio');
});
