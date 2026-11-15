import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import type { Provider, QuotaUsage, RequestLog, BansosEntry } from './types.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, 'gateway.db');

let db: DatabaseSync;

export function initDb(): DatabaseSync {
  if (db) return db;
  db = new DatabaseSync(DB_PATH);

  db.exec(`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      base_url TEXT NOT NULL,
      chat_endpoint TEXT,
      api_key TEXT NOT NULL,
      type TEXT DEFAULT 'official',
      protocol TEXT DEFAULT 'openai',
      status TEXT DEFAULT 'unknown',
      cooldown_until INTEGER DEFAULT 0,
      last_probe INTEGER DEFAULT 0,
      models TEXT DEFAULT '[]',
      rate_limits TEXT DEFAULT '{}',
      priority INTEGER DEFAULT 100,
      enabled INTEGER DEFAULT 1,
      is_free INTEGER DEFAULT 1,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS quota_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      request_count INTEGER DEFAULT 0,
      token_input INTEGER DEFAULT 0,
      token_output INTEGER DEFAULT 0,
      date TEXT NOT NULL,
      UNIQUE(provider_id, model, date)
    );

    CREATE TABLE IF NOT EXISTS request_logs (
      id TEXT PRIMARY KEY,
      timestamp INTEGER NOT NULL,
      provider_id TEXT NOT NULL,
      model TEXT NOT NULL,
      status INTEGER NOT NULL,
      latency_ms INTEGER NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      fallback_count INTEGER DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS bansos_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      url TEXT NOT NULL,
      api_key TEXT NOT NULL,
      models TEXT DEFAULT '[]',
      discovered_at INTEGER,
      expires_at INTEGER,
      status TEXT DEFAULT 'pending',
      UNIQUE(url, api_key)
    );
  `);

  return db;
}

export function getDb(): DatabaseSync {
  if (!db) initDb();
  return db;
}

// ---------- Providers ----------

export function saveProvider(p: Provider): void {
  getDb().prepare(`
    INSERT INTO providers (id, name, base_url, chat_endpoint, api_key, type, protocol, status,
      cooldown_until, last_probe, models, rate_limits, priority, enabled, is_free,
      created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      base_url=excluded.base_url, chat_endpoint=excluded.chat_endpoint,
      api_key=excluded.api_key, type=excluded.type,
      protocol=excluded.protocol, status=excluded.status,
      cooldown_until=excluded.cooldown_until, last_probe=excluded.last_probe,
      models=excluded.models, rate_limits=excluded.rate_limits,
      priority=excluded.priority, enabled=excluded.enabled,
      is_free=excluded.is_free, updated_at=excluded.updated_at
  `).run(
    p.id, p.name, p.baseUrl, p.chatEndpoint ?? null, p.apiKey, p.type, p.protocol, p.status,
    p.cooldownUntil, p.lastProbe, JSON.stringify(p.models), JSON.stringify(p.rateLimits),
    p.priority, p.enabled ? 1 : 0, p.isFree ? 1 : 0, p.createdAt, p.updatedAt
  );
}

export function getAllProviders(): Provider[] {
  const rows = getDb().prepare('SELECT * FROM providers ORDER BY priority ASC').all() as any[];
  return rows.map(rowToProvider);
}

export function getEnabledProviders(): Provider[] {
  const rows = getDb()
    .prepare('SELECT * FROM providers WHERE enabled = 1 ORDER BY priority ASC')
    .all() as any[];
  return rows.map(rowToProvider);
}

export function getProviderByName(name: string): Provider | undefined {
  const row = getDb().prepare('SELECT * FROM providers WHERE name = ?').get(name) as any;
  return row ? rowToProvider(row) : undefined;
}

export function deleteProvider(name: string): void {
  getDb().prepare('DELETE FROM providers WHERE name = ?').run(name);
}

function rowToProvider(row: any): Provider {
  return {
    id: row.id,
    name: row.name,
    baseUrl: row.base_url,
    chatEndpoint: row.chat_endpoint ?? undefined,
    apiKey: row.api_key,
    type: row.type,
    protocol: row.protocol,
    status: row.status,
    cooldownUntil: row.cooldown_until,
    lastProbe: row.last_probe,
    models: JSON.parse(row.models || '[]'),
    rateLimits: JSON.parse(row.rate_limits || '{}'),
    priority: row.priority,
    enabled: row.enabled === 1,
    isFree: row.is_free === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------- Quota ----------

export function incrementQuota(providerId: string, model: string, tokenInput: number, tokenOutput: number): void {
  const date = new Date().toISOString().slice(0, 10);
  getDb().prepare(`
    INSERT INTO quota_usage (provider_id, model, request_count, token_input, token_output, date)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(provider_id, model, date) DO UPDATE SET
      request_count = request_count + 1,
      token_input = token_input + excluded.token_input,
      token_output = token_output + excluded.token_output
  `).run(providerId, model, tokenInput, tokenOutput, date);
}

export function getQuotaToday(providerId: string, model: string): QuotaUsage | undefined {
  const date = new Date().toISOString().slice(0, 10);
  return getDb().prepare(
    'SELECT * FROM quota_usage WHERE provider_id = ? AND model = ? AND date = ?'
  ).get(providerId, model, date) as unknown as QuotaUsage | undefined;
}

// ---------- Request Logs ----------

export function logRequest(log: RequestLog): void {
  getDb().prepare(`
    INSERT INTO request_logs (id, timestamp, provider_id, model, status, latency_ms, tokens_used, fallback_count, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(log.id, log.timestamp, log.providerId, log.model, log.status, log.latencyMs, log.tokensUsed, log.fallbackCount, log.error ?? null);
}

export function getRecentLogs(limit = 100): RequestLog[] {
  return getDb().prepare(
    'SELECT * FROM request_logs ORDER BY timestamp DESC LIMIT ?'
  ).all(limit) as unknown as RequestLog[];
}

// ---------- Bansos ----------

export function saveBansos(entry: BansosEntry): boolean {
  const result = getDb().prepare(`
    INSERT OR IGNORE INTO bansos_entries (source, url, api_key, models, discovered_at, expires_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(entry.source, entry.url, entry.apiKey, JSON.stringify(entry.models), entry.discoveredAt, entry.expiresAt ?? null, entry.status);
  return Number(result.changes) > 0;
}

export function getPendingBansos(): (BansosEntry & { id: number })[] {
  const rows = getDb().prepare(
    "SELECT * FROM bansos_entries WHERE status = 'pending'"
  ).all() as any[];
  return rows.map((r) => ({
    id: r.id,
    source: r.source,
    url: r.url,
    apiKey: r.api_key,
    models: JSON.parse(r.models || '[]'),
    discoveredAt: r.discovered_at,
    expiresAt: r.expires_at,
    status: r.status,
  }));
}

export function updateBansosStatus(id: number, status: BansosEntry['status']): void {
  getDb().prepare('UPDATE bansos_entries SET status = ? WHERE id = ?').run(status, id);
}
