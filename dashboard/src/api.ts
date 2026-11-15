// Gateway API client + localStorage settings.

export interface ProviderStatus {
  name: string;
  baseUrl: string;
  type: string;
  status: string;
  priority: number;
  enabled: boolean;
  cooldownUntil: string | null;
  models: number;
}

const URL_KEY = 'gateway.url';
const KEY_KEY = 'gateway.apiKey';
export const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:8080';

export function loadGatewayUrl(): string {
  return localStorage.getItem(URL_KEY) || DEFAULT_GATEWAY_URL;
}

export function saveGatewayUrl(url: string): void {
  localStorage.setItem(URL_KEY, url);
}

export function loadApiKey(): string {
  return localStorage.getItem(KEY_KEY) || '';
}

export function saveApiKey(key: string): void {
  if (key) localStorage.setItem(KEY_KEY, key);
  else localStorage.removeItem(KEY_KEY);
}

export async function gatewayFetch(
  baseUrl: string,
  apiKey: string,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(baseUrl.replace(/\/+$/, '') + path, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  }
  return body;
}
