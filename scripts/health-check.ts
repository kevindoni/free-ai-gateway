#!/usr/bin/env node
// Standalone health check script — used by GitHub Actions cron
// Checks all seed providers against their /models endpoint and prints
// a GitHub Actions-friendly status summary. Exits 0 always (report only).
// Keys come from environment (workflow env or shell). No deps beyond tsx.

const CHECKS = [
  { name: 'groq', url: 'https://api.groq.com/openai/v1/models', envKey: 'GROQ_API_KEY' },
  { name: 'gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/models', envKey: 'GEMINI_API_KEY' },
  { name: 'openrouter', url: 'https://openrouter.ai/api/v1/models', envKey: 'OPENROUTER_API_KEY' },
  { name: 'nvidia', url: 'https://integrate.api.nvidia.com/v1/models', envKey: 'NVIDIA_API_KEY' },
  { name: 'mistral', url: 'https://api.mistral.ai/v1/models', envKey: 'MISTRAL_API_KEY' },
  { name: 'pollinations', url: 'https://text.pollinations.ai/models', envKey: '__KEYLESS__' },
  { name: 'ovhcloud', url: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models', envKey: '__KEYLESS__' },
  { name: 'llm7', url: 'https://api.llm7.io/v1/models', envKey: '__KEYLESS__' },
];

async function check(name: string, url: string, apiKey: string): Promise<string> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
    if (resp.status === 200) return 'healthy';
    if (resp.status === 429) return 'rate_limited';
    if (resp.status === 401 || resp.status === 403) return 'invalid_key';
    return `error_${resp.status}`;
  } catch (e: any) {
    return `timeout_or_error`;
  }
}

async function main() {
  console.log(`Free AI Gateway health check — ${new Date().toISOString()}`);
  console.log('─'.repeat(50));
  const results: Record<string, string> = {};

  for (const c of CHECKS) {
    const key = c.envKey === '__KEYLESS__' ? '' : (process.env[c.envKey] || '');
    const label = key ? '' : ' (keyless)';
    const status = await check(c.name, c.url, key);
    results[c.name] = status;
    console.log(`${c.name.padEnd(12)} ${status}${label}`);
  }

  console.log('─'.repeat(50));
  const healthy = Object.values(results).filter((s) => s === 'healthy').length;
  console.log(`Healthy: ${healthy}/${CHECKS.length}`);

  // Emit GitHub Actions summary
  if (process.env.GITHUB_STEP_SUMMARY) {
    const fs = await import('fs');
    const lines = [
      '## Free AI Gateway Health Check',
      '',
      '| Provider | Status |',
      '|----------|--------|',
      ...Object.entries(results).map(([n, s]) => `| ${n} | ${s === 'healthy' ? '✅' : '⚠️ ' + s} |`),
      '',
      `**Healthy:** ${healthy}/${CHECKS.length}`,
    ];
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n'));
  }
}

main();
