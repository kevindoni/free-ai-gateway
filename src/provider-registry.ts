import { randomUUID } from 'crypto';
import type { Provider, ProviderConfig, ProviderStatus } from './types.js';
import { saveProvider, getAllProviders, getEnabledProviders, getProviderByName, deleteProvider } from './database.js';

const DEFAULT_RATE_LIMITS = {
  rpm: 20,
  rpd: 100,
  tpm: 50000,
  tpd: 500000,
};

export function createProvider(config: ProviderConfig): Provider {
  const now = Date.now();
  return {
    id: randomUUID(),
    name: config.name,
    baseUrl: config.baseUrl.replace(/\/$/, ''),
    chatEndpoint: config.chatEndpoint,
    apiKey: config.apiKey,
    type: config.type ?? 'official',
    protocol: config.protocol ?? 'openai',
    status: 'unknown' as ProviderStatus,
    cooldownUntil: 0,
    lastProbe: 0,
    models: config.models ?? [],
    rateLimits: { ...DEFAULT_RATE_LIMITS, ...config.rateLimits },
    priority: config.priority ?? 100,
    enabled: true,
    isFree: config.isFree ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

export function registerProvider(config: ProviderConfig): Provider {
  const provider = createProvider(config);
  saveProvider(provider);
  return provider;
}

export function listProviders(): Provider[] {
  return getAllProviders();
}

export function listEnabledProviders(): Provider[] {
  return getEnabledProviders();
}

export function findProvider(name: string): Provider | undefined {
  return getProviderByName(name);
}

export function removeProvider(name: string): boolean {
  const existing = getProviderByName(name);
  if (!existing) return false;
  deleteProvider(name);
  return true;
}

export function updateProviderStatus(name: string, status: ProviderStatus, cooldownMs = 0): void {
  const provider = getProviderByName(name);
  if (!provider) return;
  provider.status = status;
  provider.lastProbe = Date.now();
  provider.cooldownUntil = cooldownMs > 0 ? Date.now() + cooldownMs : 0;
  provider.updatedAt = Date.now();
  saveProvider(provider);
}

export function getAvailableProviders(): Provider[] {
  const now = Date.now();
  return getEnabledProviders().filter(
    (p) => p.status !== 'invalid' && now >= p.cooldownUntil
  );
}
