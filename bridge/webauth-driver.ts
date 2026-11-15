// Non-interactive webauth driver: logs in chosen providers via Chrome CDP.
// Usage: bun webauth-driver.ts deepseek qwen kimi
// Chrome must be running in remote-debug mode first (TFG: `chrome start`).

import { listProviderDefinitions } from "./node_modules/token-free-gateway/src/providers/registry.ts";
import { saveCredentials } from "./node_modules/token-free-gateway/src/providers/auth-store.ts";

const requested = process.argv.slice(2).map((s) => s.toLowerCase());
const all = (await listProviderDefinitions()) as Array<{
	id: string;
	name: string;
	loginFn: (params: {
		onProgress: (msg: string) => void;
		openUrl: (url: string) => Promise<boolean>;
	}) => Promise<unknown>;
}>;

const targets = requested.length > 0
	? all.filter((p) => requested.some((r) => p.id.toLowerCase().includes(r) || p.name.toLowerCase().includes(r)))
	: all;

if (targets.length === 0) {
	console.error(`No providers matched: ${requested.join(", ")}`);
	console.error(`Available: ${all.map((p) => p.id).join(", ")}`);
	process.exit(1);
}

console.log(`Authorizing ${targets.length} provider(s): ${targets.map((p) => p.id).join(", ")}`);
console.log("Log in inside the Chrome tabs that open. The driver waits for each login.\n");

let ok = 0;
for (const provider of targets) {
	console.log(`━━━ ${provider.name} (${provider.id}) ━━━`);
	try {
		const credentials = await provider.loginFn({
			onProgress: (msg) => console.log(`  [${provider.id}] ${msg}`),
			openUrl: async (url) => {
				console.log(`  [${provider.id}] Open if needed: ${url}`);
				return true;
			},
		});
		if (credentials && typeof credentials === "object") {
			saveCredentials(provider.id, credentials);
			console.log(`  [${provider.id}] ✅ credentials saved\n`);
			ok++;
		} else {
			console.log(`  [${provider.id}] ❌ no credentials returned\n`);
		}
	} catch (err) {
		console.log(`  [${provider.id}] ❌ login failed: ${(err as Error).message}\n`);
	}
}

console.log(`Done. ${ok}/${targets.length} providers authorized.`);
process.exit(ok > 0 ? 0 : 1);
