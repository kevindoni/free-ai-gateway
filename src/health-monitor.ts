import axios from 'axios';
import type { Provider, ProviderStatus } from './types.js';
import { getEnabledProviders } from './database.js';
import { updateProviderStatus } from './provider-registry.js';

const HEALTH_CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '60000', 10);
const RATE_LIMIT_COOLDOWN_MS = parseInt(process.env.COOLDOWN_MS || '300000', 10);
const ERROR_COOLDOWN_MS = 60000;
const DEAD_COOLDOWN_MS = parseInt(process.env.DEAD_COOLDOWN_MS || '3600000', 10);

let monitorTimer: NodeJS.Timeout | null = null;

export async function probeProvider(provider: Provider): Promise<ProviderStatus> {
  try {
    const headers: Record<string, string> = {};
    if (provider.apiKey) {
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    const resp = await axios.get(`${provider.baseUrl}/models`, {
      headers,
      timeout: 10000,
      validateStatus: () => true,
    });

    if (resp.status === 200) return 'healthy';
    if (resp.status === 429) return 'rate_limited';
    if (resp.status === 401 || resp.status === 403) return 'invalid';
    return 'error';
  } catch (err: any) {
    if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'timeout';
    return 'error';
  }
}

function cooldownFor(status: ProviderStatus): number {
  switch (status) {
    case 'rate_limited': return RATE_LIMIT_COOLDOWN_MS;
    case 'invalid': return DEAD_COOLDOWN_MS;
    case 'error': return ERROR_COOLDOWN_MS;
    case 'timeout': return ERROR_COOLDOWN_MS;
    default: return 0;
  }
}

export async function checkAllProviders(): Promise<Record<string, ProviderStatus>> {
  const providers = getEnabledProviders();
  const results: Record<string, ProviderStatus> = {};

  await Promise.all(
    providers.map(async (p) => {
      const status = await probeProvider(p);
      updateProviderStatus(p.name, status, cooldownFor(status));
      results[p.name] = status;
    })
  );

  return results;
}

export function startHealthMonitor(intervalMs = HEALTH_CHECK_INTERVAL_MS): void {
  if (monitorTimer) return;
  console.log(`[health-monitor] Started, probing every ${intervalMs / 1000}s`);
  monitorTimer = setInterval(async () => {
    try {
      const results = await checkAllProviders();
      const healthy = Object.values(results).filter((s) => s === 'healthy').length;
      console.log(
        `[health-monitor] ${healthy}/${Object.keys(results).length} providers healthy | ` +
        Object.entries(results).map(([n, s]) => `${n}=${s}`).join(', ')
      );
    } catch (err) {
      console.error('[health-monitor] Check failed:', err);
    }
  }, intervalMs);
}

export function stopHealthMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
    console.log('[health-monitor] Stopped');
  }
}
