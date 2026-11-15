# Free AI Token Gateway 🆓

Gateway AI gratis dengan multi-provider failover, auto-discovery bansos, dan MCP server.

## Fitur

- **Multi-provider failover** — Groq, Gemini, OpenRouter, NVIDIA, Mistral, dll. Kalau satu rate-limited, otomatis pindah ke berikutnya
- **Health monitor** — probe semua provider tiap 60 detik, cooldown otomatis saat 429/5xx
- **Bansos discovery** — deteksi API key gratisan baru dari Telegram/tokengratis.id, auto-validasi & register
- **MCP server** — expose sebagai tools untuk Kilo, Claude Code, Cursor, dll
- **OpenAI-compatible** — cukup ganti `base_url` + `api_key`
- **Quota tracking** — pantau pemakaian per provider/model/harian

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Setup environment
cp .env.example .env
# Edit .env — isi minimal satu API key gratis (GROQ_API_KEY recommended)

# 3. Jalankan gateway (HTTP + health monitor)
npm run dev

# 4. Atau jalankan sebagai MCP server
npm run mcp
```

## Ambil API Key Gratis

| Provider | Link | Kuota Free |
|----------|------|-----------|
| Groq | https://console.groq.com/keys | 30 RPM, 1K req/hari |
| Gemini | https://aistudio.google.com/apikey | 15 RPM, 1.5K req/hari |
| OpenRouter | https://openrouter.ai/keys | 20 RPM, 50 req/hari |
| NVIDIA NIM | https://build.nvidia.com/ | 40 RPM |
| Mistral | https://console.mistral.ai/api-keys | ~1B token/bulan |

## Pakai dengan Kilo

Tambahkan di `kilo.json`:

```json
{
  "providers": [
    {
      "name": "free-gateway",
      "base_url": "http://127.0.0.1:8080/v1",
      "api_key": "local",
      "models": ["auto", "openai/gpt-oss-120b", "gemini-3.8-flash"]
    }
  ]
}
```

## Pakai dengan Claude Code

Gateway expose endpoint Anthropic-native `/v1/messages`, jadi Claude Code langsung jalan:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8080
export ANTHROPIC_API_KEY=local
claude
```

## Key Rotation

Satu provider bisa punya banyak API key — pisahkan dengan koma di `.env`:

```bash
# 3 akun Groq gratis → 3x kuota harian
GROQ_API_KEY=gsk_key1,gsk_key2,gsk_key3
```

Router otomatis:
- Kalau key-1 kena 429 → coba key-2 (cooldown cuma 15 detik, bukan 5 menit)
- Kalau semua key habis → pindah ke provider berikutnya
- Kalau 401/403 (key mati) → provider diparkir 1 jam

## Streaming

Streaming SSE asli di kedua protocol:
- OpenAI: `POST /v1/chat/completions` dengan `"stream": true`
- Anthropic: `POST /v1/messages` dengan `"stream": true` (events: `message_start` → `content_block_delta` → `message_stop`)

## Pakai dengan MCP Client

```json
{
  "mcpServers": {
    "free-ai-gateway": {
      "command": "node",
      "args": ["D:/PALIKASIKU/Agentbrowser/node_modules/.bin/tsx", "src/mcp-server.ts"],
      "cwd": "D:/PALIKASIKU/Agentbrowser"
    }
  }
}
```

### MCP Tools yang tersedia

| Tool | Deskripsi |
|------|-----------|
| `ask_ai` | Kirim prompt ke model gratis terbaik (auto failover) |
| `list_providers` | Lihat semua provider + status health |
| `add_provider` | Register provider baru (misal bansos dari Telegram) |
| `remove_provider` | Hapus provider mati |
| `check_health` | Probe semua provider sekarang |
| `recent_logs` | Lihat log request terakhir |

## Cara Kerja Auto-Failover

```
Request → Router
  ├── Provider A (priority 10) → 429 → cooldown 5 menit
  ├── Provider B (priority 20) → 200 → return ✓
  └── Provider C (priority 30) → standby
```

Provider status:
- `healthy` → aktif routing
- `rate_limited` → cooldown 5 menit, auto-recover
- `invalid` → key mati, cooldown 1 jam
- `error`/`timeout` → cooldown 1 menit

## Cara Kerja Bansos Discovery

```
Setiap 1 jam:
  1. Poll Telegram channels (@infobansosai, @bozdrop)
  2. Fetch tokengratis.id directory
  3. Extract API key + base URL (regex)
  4. Validasi: probe /models endpoint
  5. Valid → register ke pool (priority 300)
  6. Invalid → tolak + catat
```

## GitHub Actions (Gratis)

Repo ini include workflow cron yang:
- Health check semua provider tiap 30 menit
- Cek bansos endpoint tiap 6 jam
- Tulis summary ke GitHub Actions
- Semua gratis (public repo: 2000 min/bulan)

## API Endpoints

| Endpoint | Method | Deskripsi |
|----------|--------|-----------|
| `/v1/models` | GET | List semua model tersedia |
| `/v1/chat/completions` | POST | Chat (OpenAI format) |
| `/admin/status` | GET | Status semua provider |
| `/admin/providers` | POST | Register provider baru |
| `/admin/health-check` | POST | Trigger health check manual |
| `/admin/quota/:provider/:model` | GET | Kuota harian per provider |

## Arsitektur

Lihat [ARCHITECTURE.md](./ARCHITECTURE.md) untuk diagram lengkap (ERD, flow, roadmap).

## License

MIT
