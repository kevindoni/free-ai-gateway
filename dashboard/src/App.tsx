import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { ProviderStatus } from './api';
import {
  DEFAULT_GATEWAY_URL,
  gatewayFetch,
  loadApiKey,
  loadGatewayUrl,
  saveApiKey,
  saveGatewayUrl,
} from './api';

type View = 'providers' | 'quota' | 'settings';

function statusBadge(status: string, cooldownUntil: string | null): ReactElement {
  if (cooldownUntil) {
    return <span className="badge cooldown">cooldown until {cooldownUntil.slice(11, 19)}Z</span>;
  }
  const cls =
    status === 'healthy' ? 'ok' : status === 'rate_limited' ? 'warn' : 'err';
  return <span className={`badge ${cls}`}>{status}</span>;
}

function Providers({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({ name: '', baseUrl: '', apiKey: '', models: '', priority: '100' });
  const [formMsg, setFormMsg] = useState('');

  const refresh = useCallback(async () => {
    setError('');
    try {
      const data = (await gatewayFetch(baseUrl, apiKey, '/admin/status')) as { providers: ProviderStatus[] };
      setProviders(data.providers ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [baseUrl, apiKey]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const healthCheck = async () => {
    setBusy(true);
    setError('');
    try {
      await gatewayFetch(baseUrl, apiKey, '/admin/health-check', { method: 'POST' });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const addProvider = async (ev: React.FormEvent) => {
    ev.preventDefault();
    setFormMsg('');
    try {
      const models = form.models.split(',').map((m) => m.trim()).filter(Boolean);
      await gatewayFetch(baseUrl, apiKey, '/admin/providers', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          baseUrl: form.baseUrl,
          apiKey: form.apiKey,
          models,
          priority: parseInt(form.priority, 10) || 100,
        }),
      });
      setFormMsg(`Added "${form.name}".`);
      setForm({ name: '', baseUrl: '', apiKey: '', models: '', priority: '100' });
      await refresh();
    } catch (e) {
      setFormMsg(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <div className="toolbar">
        <button onClick={healthCheck} disabled={busy}>
          {busy ? 'Checking…' : 'Health check now'}
        </button>
        <button onClick={refresh}>Refresh</button>
      </div>
      {error && <p className="error">{error}</p>}
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Type</th>
            <th>Status</th>
            <th>Priority</th>
            <th>Models</th>
            <th>Enabled</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((p) => (
            <tr key={p.name}>
              <td>{p.name}</td>
              <td>{p.type}</td>
              <td>{statusBadge(p.status, p.cooldownUntil)}</td>
              <td>{p.priority}</td>
              <td>{p.models}</td>
              <td>{p.enabled ? '✓' : '✗'}</td>
            </tr>
          ))}
          {providers.length === 0 && !error && (
            <tr>
              <td colSpan={6}>No providers reported.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3>Add provider</h3>
      <form onSubmit={addProvider} className="add-form">
        <input placeholder="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="baseUrl (https://…/v1)" required value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })} />
        <input placeholder="apiKey (optional)" value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} />
        <input placeholder="models, comma, separated" value={form.models} onChange={(e) => setForm({ ...form, models: e.target.value })} />
        <input placeholder="priority" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
        <button type="submit">Add</button>
      </form>
      {formMsg && <p className={formMsg.startsWith('Added') ? 'hint' : 'error'}>{formMsg}</p>}
    </>
  );
}

function Quota({ baseUrl, apiKey }: { baseUrl: string; apiKey: string }) {
  const [provider, setProvider] = useState('');
  const [model, setModel] = useState('');
  const [result, setResult] = useState('');
  const [busy, setBusy] = useState(false);

  const fetchQuota = async () => {
    if (!provider || !model) return;
    setBusy(true);
    setResult('');
    try {
      const data = await gatewayFetch(
        baseUrl,
        apiKey,
        `/admin/quota/${encodeURIComponent(provider)}/${encodeURIComponent(model)}`,
      );
      setResult(JSON.stringify(data, null, 2));
    } catch (e) {
      setResult(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="toolbar">
        <input placeholder="provider name" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <input placeholder="model id" value={model} onChange={(e) => setModel(e.target.value)} />
        <button onClick={fetchQuota} disabled={busy || !provider || !model}>
          {busy ? 'Fetching…' : 'Fetch quota'}
        </button>
      </div>
      <pre className="json">{result || 'Provider + model required. Result shown as JSON.'}</pre>
    </>
  );
}

function Settings({
  url,
  setUrl,
  apiKey,
  setApiKey,
}: {
  url: string;
  setUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
}) {
  return (
    <>
      <h3>Gateway connection</h3>
      <p className="hint">Saved to browser localStorage. The header inputs write the same keys.</p>
      <div className="settings-form">
        <label>
          Gateway URL
          <input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              saveGatewayUrl(e.target.value);
            }}
            placeholder={DEFAULT_GATEWAY_URL}
          />
        </label>
        <label>
          API key (optional, sent as Authorization: Bearer)
          <input
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              saveApiKey(e.target.value);
            }}
            placeholder="GATEWAY_API_KEY"
          />
        </label>
        <button
          onClick={() => {
            setUrl(DEFAULT_GATEWAY_URL);
            saveGatewayUrl(DEFAULT_GATEWAY_URL);
          }}
        >
          Reset URL to default
        </button>
      </div>
      <h3>Logs</h3>
      <p className="hint">Log viewing is available via MCP tool <code>recent_logs</code> (no HTTP endpoint yet).</p>
    </>
  );
}

export default function App() {
  const [view, setView] = useState<View>('providers');
  const [url, setUrl] = useState(loadGatewayUrl);
  const [apiKey, setApiKey] = useState(loadApiKey);

  return (
    <div className="app">
      <header>
        <h1>Free AI Gateway — Admin</h1>
        <div className="header-controls">
          <input
            className="gw-url"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              saveGatewayUrl(e.target.value);
            }}
            placeholder="Gateway URL"
            title="Gateway base URL (saved to localStorage)"
          />
          <input
            className="gw-key"
            value={apiKey}
            onChange={(e) => {
              setApiKey(e.target.value);
              saveApiKey(e.target.value);
            }}
            placeholder="API key (optional)"
            title="Sent as Authorization: Bearer (saved to localStorage)"
          />
        </div>
      </header>
      <nav>
        {(['providers', 'quota', 'settings'] as View[]).map((v) => (
          <button key={v} className={view === v ? 'active' : ''} onClick={() => setView(v)}>
            {v.charAt(0).toUpperCase() + v.slice(1)}
          </button>
        ))}
      </nav>
      <main>
        {view === 'providers' && <Providers baseUrl={url} apiKey={apiKey} />}
        {view === 'quota' && <Quota baseUrl={url} apiKey={apiKey} />}
        {view === 'settings' && (
          <Settings
            url={url}
            setUrl={setUrl}
            apiKey={apiKey}
            setApiKey={setApiKey}
          />
        )}
      </main>
    </div>
  );
}
