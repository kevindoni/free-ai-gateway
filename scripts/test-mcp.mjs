// End-to-end MCP test: spawns the MCP server exactly like Kilo does,
// handshakes, lists tools, then calls ask_ai + list_providers.
// Usage: node scripts/test-mcp.mjs "prompt here"

import { spawn } from 'node:child_process';

const prompt = process.argv[2] || 'Reply with exactly: MCP-TEST-OK';
const serverCmd = process.execPath;
const serverArgs = [
  'D:/PALIKASIKU/Agentbrowser/node_modules/tsx/dist/cli.mjs',
  'D:/PALIKASIKU/Agentbrowser/src/mcp-server.ts',
];

const child = spawn(serverCmd, serverArgs, {
  env: { ...process.env, DATA_DIR: 'D:/PALIKASIKU/Agentbrowser/data' },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    } catch {
      // ignore non-JSON lines (stderr banners come via stderr)
    }
  }
});

child.stderr.on('data', (c) => process.stderr.write(c));

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const timeout = (ms) => new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms));

async function main() {
  // 1. initialize
  const init = await Promise.race([
    send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'kilo-test', version: '1.0.0' },
    }),
    timeout(15000),
  ]);
  console.log('1. initialize:', init.result?.serverInfo ? `OK (${init.result.serverInfo.name} v${init.result.serverInfo.version})` : 'FAIL');

  // 2. initialized notification
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  // 3. tools/list
  const list = await Promise.race([send('tools/list', {}), timeout(10000)]);
  const tools = list.result?.tools?.map((t) => t.name) ?? [];
  console.log(`2. tools/list: ${tools.length} tools → ${tools.join(', ')}`);

  // 4. tools/call ask_ai (real model through the free pool)
  console.log(`3. ask_ai "${prompt}" ...`);
  const ask = await Promise.race([
    send('tools/call', {
      name: 'ask_ai',
      arguments: { prompt, model: 'auto', max_tokens: 2000 },
    }),
    timeout(180000),
  ]);
  const content = ask.result?.content ?? [];
  const text = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  console.log(`   ask_ai: ${ask.result?.isError ? 'ERROR' : 'OK'}`);
  console.log('   response:', text.slice(0, 300));

  // 5. tools/call list_providers
  const provs = await Promise.race([send('tools/call', { name: 'list_providers', arguments: {} }), timeout(15000)]);
  const provText = provs.result?.content?.[0]?.text ?? '[]';
  const parsed = JSON.parse(provText);
  console.log(`4. list_providers: ${parsed.length} providers`);
  for (const p of parsed) {
    console.log(`   - ${p.name.padEnd(16)} ${p.status.padEnd(10)} prio=${p.priority} models=${p.models.length}`);
  }

  child.kill();
  process.exit(0);
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  child.kill();
  process.exit(1);
});
