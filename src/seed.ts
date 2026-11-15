// Seed provider registry from environment variables on first boot.

import { findProvider, registerProvider } from './provider-registry.js';

interface SeedDef {
  name: string;
  envKey: string;
  baseUrl: string;
  chatEndpoint?: string;
  models: string[];
  priority: number;
  type: 'official' | 'gateway' | 'keyless';
  rateLimits?: { rpm: number; rpd: number; tpm?: number; tpd?: number };
}

const SEEDS: SeedDef[] = [
  {
    name: 'groq',
    envKey: 'GROQ_API_KEY',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3.8-27b'],
    priority: 10,
    type: 'official',
    rateLimits: { rpm: 30, rpd: 1000, tpm: 8000, tpd: 200000 },
  },
  {
    name: 'gemini',
    envKey: 'GEMINI_API_KEY',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'],
    priority: 20,
    type: 'official',
    rateLimits: { rpm: 15, rpd: 1500 },
  },
  {
    name: 'openrouter',
    envKey: 'OPENROUTER_API_KEY',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['openrouter/free'],
    priority: 30,
    type: 'gateway',
    rateLimits: { rpm: 20, rpd: 50 },
  },
  {
    name: 'nvidia',
    envKey: 'NVIDIA_API_KEY',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    models: ['nvidia/nemotron-3-super-120b-a12b'],
    priority: 40,
    type: 'official',
    rateLimits: { rpm: 40, rpd: 10000 },
  },
  {
    name: 'mistral',
    envKey: 'MISTRAL_API_KEY',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['codestral-latest', 'mistral-small-latest'],
    priority: 50,
    type: 'official',
    rateLimits: { rpm: 15, rpd: 500 },
  },
  {
    name: 'pollinations',
    envKey: '__KEYLESS__',
    baseUrl: 'https://text.pollinations.ai',
    chatEndpoint: 'https://text.pollinations.ai/openai',
    models: ['openai'],
    priority: 200,
    type: 'keyless',
  },
  {
    name: 'ovhcloud',
    envKey: '__KEYLESS__',
    baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
    models: ['Qwen3.8-27B', 'gpt-oss-20b', 'Mistral-Small-3.2-24B-Instruct-2506'],
    priority: 210,
    type: 'keyless',
    rateLimits: { rpm: 2, rpd: 2000 },
  },
  {
    name: 'llm7',
    envKey: '__KEYLESS__',
    baseUrl: 'https://api.llm7.io/v1',
    models: ['DeepSeek-V4-Flash-0731', 'L3-8B-Lunaris-v1-Turbo'],
    priority: 220,
    type: 'keyless',
  },
];

export function seedFromEnv(): void {
  let added = 0;
  for (const seed of SEEDS) {
    if (findProvider(seed.name)) continue;
    const apiKey = seed.envKey === '__KEYLESS__' ? '' : (process.env[seed.envKey] || '');
    if (!apiKey && seed.type !== 'keyless') continue;
    registerProvider({
      name: seed.name,
      baseUrl: seed.baseUrl,
      chatEndpoint: seed.chatEndpoint,
      apiKey,
      models: seed.models,
      priority: seed.priority,
      type: seed.type,
      rateLimits: seed.rateLimits,
    });
    added++;
    console.log(`[seed] Registered provider "${seed.name}"`);
  }
  if (added === 0) console.log('[seed] No new providers to register');
  void seedWebbridge();
}

// Register the local browser-bridge (token-free-gateway on :3456) only when it is reachable.
async function seedWebbridge(): Promise<void> {
  if (findProvider('webbridge-tfg')) return;
  try {
    const resp = await fetch('http://127.0.0.1:3456/v1/models', { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return;
    const data = (await resp.json()) as { data?: Array<{ id: string }> };
    const models = (data.data ?? []).map((m) => m.id).slice(0, 50);
    registerProvider({
      name: 'webbridge-tfg',
      baseUrl: 'http://127.0.0.1:3456/v1',
      apiKey: process.env.TFG_API_KEY || '',
      models: models.length > 0 ? models : ['auto'],
      priority: 250,
      type: 'gateway',
    });
    console.log(`[seed] Registered webbridge-tfg (${models.length} web models)`);
  } catch {
    console.log('[seed] webbridge-tfg not running — skipped (start with: bun bridge/node_modules/token-free-gateway/index.ts serve)');
  }
}
