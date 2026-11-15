// Prompt cache: exact + fuzzy lookup, persisted in SQLite (prompt_cache table)
import { createHash } from 'node:crypto';
import type { ChatRequest } from './types.js';
import { getDb } from './database.js';

export interface CacheEntry {
  key: string;
  model: string;
  response: string;
  provider: string;
  createdAt: number;
  hits: number;
}

type Message = ChatRequest['messages'][number];

const CAP = 500;
const TRIGRAM_THRESHOLD = 0.92;
const FUZZY_SCAN_LIMIT = 100;

let initialized = false;

export function initCache(): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS prompt_cache (
      key TEXT PRIMARY KEY,
      model TEXT,
      messages_hash TEXT,
      normalized TEXT,
      response TEXT,
      provider TEXT,
      created_at INTEGER,
      hits INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_prompt_cache_hash ON prompt_cache(messages_hash);
  `);
  initialized = true;
}

function ensureInit(): void {
  if (!initialized) initCache();
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

// Canonical model name: strip ":suffix" (e.g. "llama-3.3-70b:free" -> "llama-3.3-70b")
function canonicalModel(model: string): string {
  const i = model.lastIndexOf(':');
  return i > 0 ? model.slice(0, i) : model;
}

// Lowercase, strip punctuation, collapse whitespace
function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function exactKey(model: string, messages: ChatRequest['messages']): string {
  return sha256(JSON.stringify({ model: canonicalModel(model), messages }));
}

function fuzzyHash(model: string, messages: ChatRequest['messages']): string {
  const normalized = messages.map((m) => ({ role: m.role, content: normalizeText(m.content) }));
  return sha256(JSON.stringify({ model: canonicalModel(model), messages: normalized }));
}

function lastUserMessage(messages: ChatRequest['messages']): Message | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i];
  }
  return undefined;
}

// normalized column payload: full normalized text + normalized last user message
function normalizedPayload(messages: ChatRequest['messages']): string {
  const lastUser = lastUserMessage(messages);
  return JSON.stringify({
    t: messages.map((m) => normalizeText(m.content)).join(' '),
    u: normalizeText(lastUser?.content ?? ''),
  });
}

function parseStoredNormalized(raw: unknown): { t: string; u: string } {
  if (typeof raw !== 'string') return { t: '', u: '' };
  try {
    const parsed = JSON.parse(raw) as { t?: unknown; u?: unknown };
    return { t: typeof parsed.t === 'string' ? parsed.t : '', u: typeof parsed.u === 'string' ? parsed.u : '' };
  } catch {
    return { t: '', u: '' };
  }
}

function trigrams(text: string): Set<string> {
  const set = new Set<string>();
  if (text.length < 3) {
    if (text.length > 0) set.add(text);
    return set;
  }
  for (let i = 0; i <= text.length - 3; i++) set.add(text.slice(i, i + 3));
  return set;
}

// Overlap coefficient over character trigram sets: containment-tolerant fuzzy match
function trigramSimilarity(a: string, b: string): number {
  const ta = trigrams(a);
  const tb = trigrams(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const g of ta) if (tb.has(g)) inter++;
  return inter / Math.min(ta.size, tb.size);
}

interface CacheRow {
  key: string;
  response: string;
  provider: string;
  normalized?: string;
}

function bumpHits(key: string): void {
  getDb().prepare('UPDATE prompt_cache SET hits = hits + 1 WHERE key = ?').run(key);
}

export function cacheLookup(
  model: string,
  messages: ChatRequest['messages'],
): { hit: boolean; response?: string; provider?: string; key?: string } {
  ensureInit();
  const db = getDb();

  // 1. Exact hash match
  const key = exactKey(model, messages);
  const exact = db.prepare('SELECT key, response, provider FROM prompt_cache WHERE key = ?').get(key) as
    | CacheRow
    | undefined;
  if (exact) {
    bumpHits(exact.key);
    return { hit: true, response: exact.response, provider: exact.provider, key: exact.key };
  }

  // 2. Fuzzy: normalized hash match
  const hash = fuzzyHash(model, messages);
  const fuzzy = db
    .prepare('SELECT key, response, provider FROM prompt_cache WHERE messages_hash = ? ORDER BY created_at DESC LIMIT 1')
    .get(hash) as CacheRow | undefined;
  if (fuzzy) {
    bumpHits(fuzzy.key);
    return { hit: true, response: fuzzy.response, provider: fuzzy.provider, key: fuzzy.key };
  }

  // 3. Trigram similarity of last user message vs recent cache rows
  const lastUser = lastUserMessage(messages);
  if (lastUser) {
    const query = normalizeText(lastUser.content);
    if (query.length > 0) {
      const rows = db
        .prepare('SELECT key, response, provider, normalized FROM prompt_cache ORDER BY created_at DESC LIMIT ?')
        .all(FUZZY_SCAN_LIMIT) as unknown as CacheRow[];
      for (const row of rows) {
        const stored = parseStoredNormalized(row.normalized);
        if (!stored.u) continue;
        if (trigramSimilarity(query, stored.u) >= TRIGRAM_THRESHOLD) {
          bumpHits(row.key);
          return { hit: true, response: row.response, provider: row.provider, key: row.key };
        }
      }
    }
  }

  return { hit: false };
}

export function cacheStore(model: string, messages: ChatRequest['messages'], response: string, provider: string): void {
  ensureInit();
  const db = getDb();
  const key = exactKey(model, messages);
  const hash = fuzzyHash(model, messages);
  db.prepare(`
    INSERT INTO prompt_cache (key, model, messages_hash, normalized, response, provider, created_at, hits)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(key) DO UPDATE SET
      model=excluded.model, messages_hash=excluded.messages_hash,
      normalized=excluded.normalized, response=excluded.response,
      provider=excluded.provider, created_at=excluded.created_at
  `).run(key, canonicalModel(model), hash, normalizedPayload(messages), response, provider, Date.now());

  // Cap table at 500 rows, drop oldest
  db.prepare(
    `DELETE FROM prompt_cache WHERE key NOT IN (SELECT key FROM prompt_cache ORDER BY created_at DESC LIMIT ${CAP})`,
  ).run();
}

export function cacheStats(): { entries: number; hits: number } {
  ensureInit();
  const row = getDb()
    .prepare('SELECT COUNT(*) AS entries, COALESCE(SUM(hits), 0) AS hits FROM prompt_cache')
    .get() as { entries: number; hits: number };
  return { entries: Number(row.entries), hits: Number(row.hits) };
}
