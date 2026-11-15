// Bansos Discovery Engine
// Monitors public sources for new free AI gateway offers, validates them,
// and registers the valid ones into the provider pool.
//
// Sources:
//  - Telegram channels (via bot API, needs TELEGRAM_BOT_TOKEN)
//  - GitHub topics/repos (bansos, free-llm-api)
//  - tokengratis.id directory (JSON API, CORS open)
//
// Extraction strategy: regex for base URLs + API keys in messages.

import axios from 'axios';
import { saveBansos, getPendingBansos, updateBansosStatus } from './database.js';
import { findProvider, registerProvider } from './provider-registry.js';
import { probeProvider } from './health-monitor.js';
import { createProvider } from './provider-registry.js';

const DISCOVERY_INTERVAL_MS = parseInt(process.env.DISCOVERY_INTERVAL_MS || '3600000', 10);
const KEY_RE = /sk-[A-Za-z0-9_\-]{10,}/g;
const URL_RE = /https?:\/\/[a-zA-Z0-9.\-]+\.[a-z]{2,}(?::\d+)?(?:\/[a-zA-Z0-9._\-\/]*)?/g;

let discoveryTimer: NodeJS.Timeout | null = null;

interface RawOffer {
  source: string;
  url: string;
  apiKey: string;
  models: string[];
}

function extractOffers(text: string, source: string): RawOffer[] {
  const offers: RawOffer[] = [];
  const keys = text.match(KEY_RE) ?? [];
  const urls = (text.match(URL_RE) ?? []).filter(
    (u) => !u.includes('github.com') && !u.includes('t.me') && !u.includes('facebook.com')
  );

  for (const key of keys) {
    for (const url of urls) {
      if (!url.includes('/v1')) continue;
      offers.push({ source, url: url.replace(/\/$/, ''), apiKey: key, models: [] });
    }
  }
  return offers;
}

async function discoverTelegram(): Promise<RawOffer[]> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return [];
  const channels = (process.env.TELEGRAM_CHANNELS || '@infobansosai,@bozdrop').split(',');
  const offers: RawOffer[] = [];

  for (const channel of channels) {
    try {
      const resp = await axios.get(
        `https://api.telegram.org/bot${token}/getUpdates`,
        { timeout: 15000, validateStatus: () => true }
      );
      if (resp.status !== 200 || !resp.data?.ok) continue;
      for (const update of resp.data.result ?? []) {
        const msg = update.channel_post ?? update.message;
        const text = msg?.text ?? msg?.caption ?? '';
        if (text) offers.push(...extractOffers(text, `telegram:${channel}`));
      }
    } catch {
      // ignore channel errors
    }
  }
  return offers;
}

async function discoverTokengratis(): Promise<RawOffer[]> {
  // tokengratis.id publishes an open JSON API of free providers
  try {
    const resp = await axios.get('https://tokengratis.id/api/providers', {
      timeout: 20000,
      validateStatus: () => true,
    });
    if (resp.status !== 200 || !Array.isArray(resp.data)) return [];
    const offers: RawOffer[] = [];
    for (const p of resp.data) {
      const baseUrl = p?.baseUrl ?? p?.base_url;
      if (!baseUrl) continue;
      offers.push({
        source: 'tokengratis.id',
        url: baseUrl,
        apiKey: '', // providers here use your own free keys
        models: (p?.models ?? []).slice(0, 10).map((m: any) => m?.name ?? m?.id ?? String(m)).filter(Boolean),
      });
    }
    return offers;
  } catch {
    return [];
  }
}

async function validateOffer(offer: RawOffer): Promise<boolean> {
  if (offer.source === 'tokengratis.id') return false; // directory entries need user keys, skip auto-register
  if (!offer.apiKey) return false;

  const testProvider = createProvider({
    name: `__probe__${Date.now()}`,
    baseUrl: offer.url,
    apiKey: offer.apiKey,
  });
  const status = await probeProvider(testProvider);
  return status === 'healthy';
}

export async function runDiscovery(): Promise<{ found: number; registered: number; rejected: number }> {
  console.log('[discovery] Running bansos discovery...');
  const raw = [...(await discoverTelegram()), ...(await discoverTokengratis())];
  let registered = 0;
  let rejected = 0;

  for (const offer of raw) {
    const isNew = saveBansos({
      source: offer.source,
      url: offer.url,
      apiKey: offer.apiKey,
      models: offer.models,
      discoveredAt: Date.now(),
      status: 'pending',
    });
    if (!isNew) continue;
  }

  // Validate pending entries
  const pending = getPendingBansos();
  for (const entry of pending) {
    const providerName = `bansos-${entry.source.split(':').pop()}-${entry.discoveredAt}`;
    if (findProvider(providerName)) {
      updateBansosStatus(entry.id, 'valid');
      continue;
    }

    const valid = await validateOffer({
      source: entry.source,
      url: entry.url,
      apiKey: entry.apiKey,
      models: entry.models,
    });

    if (valid) {
      registerProvider({
        name: providerName,
        baseUrl: entry.url,
        apiKey: entry.apiKey,
        models: entry.models,
        priority: 300, // bansos = lower priority than official free tiers
        type: 'bansos',
      });
      console.log(`[discovery] Registered bansos provider: ${providerName} (${entry.url})`);
      registered++;
    } else {
      console.log(`[discovery] Rejected invalid bansos from ${entry.url}`);
      rejected++;
    }
  }

  console.log(`[discovery] Done. found=${raw.length} registered=${registered} rejected=${rejected}`);
  return { found: raw.length, registered, rejected };
}

export function startDiscovery(intervalMs = DISCOVERY_INTERVAL_MS): void {
  if (discoveryTimer) return;
  console.log(`[discovery] Started, every ${intervalMs / 60000}min`);
  discoveryTimer = setInterval(() => {
    runDiscovery().catch((e) => console.error('[discovery] Failed:', e.message));
  }, intervalMs);
  // Run once at boot in background
  runDiscovery().catch((e) => console.error('[discovery] Initial run failed:', e.message));
}

export function stopDiscovery(): void {
  if (discoveryTimer) {
    clearInterval(discoveryTimer);
    discoveryTimer = null;
  }
}
