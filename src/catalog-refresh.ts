import axios from 'axios';
import type { Provider } from './types.js';
import { getEnabledProviders, getProviderByName, saveProvider } from './database.js';

const DEFAULT_INTERVAL_MS = 3600000;
const REQUEST_TIMEOUT_MS = 15000;
const MAX_MODELS = 100;
const NON_CHAT_PATTERN = /embed|whisper|tts|rerank|guard|image|video|audio|moderation/i;

let refreshTimer: NodeJS.Timeout | null = null;

export interface CatalogRefreshResult {
  ok: boolean;
  count: number;
  models: string[];
}

export interface CatalogSummary {
  ok: boolean;
  count: number;
}

function firstApiKey(provider: Provider): string {
  return provider.apiKey.split(',')[0]?.trim() ?? '';
}

function extractRawIds(data: unknown): string[] {
  let entries: unknown[] = [];
  if (Array.isArray(data)) {
    entries = data; // Plain array: [{id}] | [{name}] | ["id"] (e.g. Pollinations)
  } else if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    if (Array.isArray(obj.data)) entries = obj.data; // OpenAI format: { data: [{ id }] }
    else if (Array.isArray(obj.models)) entries = obj.models; // Gemini native: { models: [{ name }] }
    else return [];
  } else {
    return [];
  }

  const ids: string[] = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      ids.push(entry);
      continue;
    }
    if (entry && typeof entry === 'object') {
      const e = entry as Record<string, unknown>;
      if (typeof e.id === 'string') ids.push(e.id);
      else if (typeof e.name === 'string') ids.push(e.name);
    }
  }
  return ids;
}

function toChatModels(rawIds: string[]): string[] {
  const filtered = rawIds.filter((id) => !NON_CHAT_PATTERN.test(id));
  return [...new Set(filtered)].slice(0, MAX_MODELS);
}

export async function refreshCatalogFor(provider: Provider): Promise<CatalogRefreshResult> {
  try {
    const headers: Record<string, string> = {};
    const key = firstApiKey(provider);
    if (key) headers['Authorization'] = `Bearer ${key}`;

    const resp = await axios.get(`${provider.baseUrl}/models`, {
      headers,
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    });

    if (resp.status !== 200) return { ok: false, count: 0, models: [] };

    const models = toChatModels(extractRawIds(resp.data));
    if (models.length === 0) return { ok: false, count: 0, models: [] };

    const fresh = getProviderByName(provider.name);
    if (!fresh) return { ok: false, count: 0, models: [] };

    fresh.models = models;
    fresh.updatedAt = Date.now();
    saveProvider(fresh);

    return { ok: true, count: models.length, models };
  } catch {
    return { ok: false, count: 0, models: [] };
  }
}

export async function refreshAllCatalogs(): Promise<Record<string, CatalogSummary>> {
  const providers = getEnabledProviders();
  const results: Record<string, CatalogSummary> = {};

  await Promise.all(
    providers.map(async (p) => {
      const res = await refreshCatalogFor(p);
      results[p.name] = { ok: res.ok, count: res.count };
    })
  );

  return results;
}

async function runCatalogRefresh(): Promise<void> {
  try {
    const results = await refreshAllCatalogs();
    const entries = Object.values(results);
    const total = entries.reduce((sum, r) => sum + r.count, 0);
    console.log(`[catalog] refreshed ${entries.length} providers, ${total} models total`);
  } catch (err) {
    console.error('[catalog] refresh run failed:', err);
  }
}

export function startCatalogRefresh(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (refreshTimer) return;
  console.log(`[catalog] Started, refreshing every ${intervalMs / 1000}s`);
  void runCatalogRefresh();
  refreshTimer = setInterval(() => {
    void runCatalogRefresh();
  }, intervalMs);
}

export function stopCatalogRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    console.log('[catalog] Stopped');
  }
}
