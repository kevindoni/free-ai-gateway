# Arsitektur Free AI Token Gateway

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    FREE AI TOKEN GATEWAY                     │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  HTTP API (Express) — OpenAI-compatible                │  │
│  │  • /v1/models       → list semua model                 │  │
│  │  • /v1/chat/completions → route ke provider terbaik    │  │
│  │  • /admin/*         → status, add provider, health     │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       │                                      │
│  ┌────────────────────▼───────────────────────────────────┐  │
│  │  ROUTER                                                │  │
│  │  • Pilih provider by priority (10=Groq, 20=Gemini...)  │  │
│  │  • Skip: cooldown / invalid / disabled                 │  │
│  │  • Fallback up to 20 attempts                          │  │
│  │  • 429 → cooldown 5 min; 401/403 → dead 1 hour         │  │
│  └────────────────────┬───────────────────────────────────┘  │
│                       │                                      │
│  ┌────────────────────▼───────────────────────────────────┐  │
│  │  PROVIDER POOL (SQLite)                                │  │
│  │  P10 Groq    P20 Gemini    P30 OpenRouter               │  │
│  │  P40 NVIDIA  P50 Mistral   P200 Keyless                │  │
│  │  P300 Bansos (auto-discovered)                         │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  HEALTH MONITOR (setiap 60 detik)                      │  │
│  │  • Probe /models endpoint per provider                 │  │
│  │  • healthy / rate_limited / invalid / error / timeout  │  │
│  │  • Auto-cooldown + auto-recover                        │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  BANSOS DISCOVERY (setiap 1 jam)                       │  │
│  │  • Telegram: @infobansosai, @bozdrop                   │  │
│  │  • tokengratis.id JSON API                             │  │
│  │  • Extract: sk-xxx keys + /v1 URLs (regex)             │  │
│  │  • Validasi probe → register priority 300              │  │
│  └────────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  MCP SERVER (stdio)                                    │  │
│  │  Tools: ask_ai, list_providers, add_provider,          │  │
│  │         remove_provider, check_health, recent_logs     │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                       GITHUB (gratis)                        │
│                                                              │
│  • Actions cron 30min: health check semua provider           │
│  • Actions cron 6h: bansos endpoint status                   │
│  • Step Summary: tabel status provider                       │
│  • Pages (opsional): dashboard UI                            │
└─────────────────────────────────────────────────────────────┘
```

## ERD (SQLite)

```
┌──────────────────┐
│    providers     │
├──────────────────┤
│ id TEXT PK       │
│ name TEXT UNIQUE │◄──── satuan dari seed + bansos discovery
│ base_url TEXT    │
│ api_key TEXT     │
│ type TEXT        │ official | gateway | keyless | bansos
│ protocol TEXT    │ openai | anthropic | gemini
│ status TEXT      │ healthy | rate_limited | invalid | error | timeout
│ cooldown_until N │
│ last_probe N     │
│ models TEXT      │ JSON array
│ rate_limits TEXT │ JSON {rpm, rpd, tpm, tpd}
│ priority N       │ 10 (Groq) ... 300 (bansos)
│ enabled N        │ 0/1
│ is_free N        │ 0/1
└──────┬───────────┘
       │ 1:N
       ▼
┌──────────────────┐     ┌──────────────────┐
│   quota_usage    │     │  request_logs    │
├──────────────────┤     ├──────────────────┤
│ provider_id FK   │     │ id TEXT PK       │
│ model TEXT       │     │ provider_id FK   │
│ request_count N  │     │ model TEXT       │
│ token_input N    │     │ status N         │
│ token_output N   │     │ latency_ms N     │
│ date TEXT        │     │ tokens_used N    │
│ UNIQUE(pid,mdl,d)│     │ fallback_count N │
└──────────────────┘     │ error TEXT       │
                         └──────────────────┘
┌──────────────────┐
│  bansos_entries  │
├──────────────────┤
│ source TEXT      │ telegram:xxx | tokengratis.id
│ url TEXT         │
│ api_key TEXT     │
│ models TEXT      │
│ discovered_at N  │
│ expires_at N     │
│ status TEXT      │ pending | valid | invalid | expired
│ UNIQUE(url, key) │
└──────────────────┘
```

## Request Flow

```
Client (Kilo/Claude Code)
  │ POST /v1/chat/completions {model: "auto", messages: [...]}
  ▼
Auth check (GATEWAY_API_KEY)
  ▼
Router.selectProviders(model)
  ├─ Filter: enabled, not invalid, not in cooldown
  ├─ Prefer providers that list model explicitly
  └─ Sort by priority ASC
  ▼
Loop (max 20 attempts):
  ├─ POST provider /chat/completions
  ├─ 200 → increment quota, log, return ✓
  ├─ 429 → cooldown 5min, next provider
  ├─ 401/403 → dead 1 hour, next provider
  └─ error/timeout → next provider
  ▼
All failed → 502 + error detail per attempt
```

## Roadmap

### Phase 1 (current)
- [x] Express gateway OpenAI-compatible
- [x] Router dengan priority + failover
- [x] SQLite persistence (providers, quota, logs, bansos)
- [x] Health monitor loop
- [x] Seed dari .env (Groq, Gemini, OpenRouter, NVIDIA, Mistral, Pollinations)
- [x] MCP server dengan 6 tools
- [x] GitHub Actions cron health check

### Phase 2 (done)
- [x] Anthropic /v1/messages endpoint (+ count_tokens stub)
- [x] Streaming SSE asli (OpenAI passthrough + Anthropic event mapping)
- [x] Key rotation (banyak key per provider, 429→rotate 15s cooldown)
- [x] Tool calling passthrough + bridge (non-streaming & streaming, OpenAI tool_calls ↔ Anthropic tool_use blocks)
- [ ] Bansos discovery aktif (Telegram bot token needed)

### Phase 3 (done)
- [x] Admin dashboard (React) — dashboard/, deploy via GitHub Pages (pages.yml)
- [x] Prompt cache (exact → normalized → trigram fuzzy, SQLite, cap 500)
- [x] Context compression (extractive, hemat token, otomatis sebelum cache/forward)
- [x] Multi-arch Docker build (Dockerfile amd64+arm64, GHCR via docker.yml)
- [x] Model catalog auto-refresh (catalog-refresh.ts, per jam, filter non-chat)

### Phase 4
- [ ] Model catalog auto-refresh dari tiap provider
- [ ] Prediksi quota habis (ML)
- [ ] OAuth auto-refresh (Gemini CLI, Qwen Code)
- [ ] SDK untuk Node/Python
