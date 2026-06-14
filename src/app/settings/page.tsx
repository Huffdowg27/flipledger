'use client';

import { useState, useEffect } from 'react';
import { Save, TestTube, RefreshCw, CheckCircle, XCircle, AlertCircle, KeyRound } from 'lucide-react';
import { formatRelativeTime } from '@/lib/formatters';

interface SettingsData {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId: string;
  lastSync: string | null;
  extensionApiKey: string;
  veeqo_api_key?: string;
  airtable_api_key?: string;
  profit_target_monthly?: string;
}

interface SyncResult {
  syncType: string;
  recordsFetched: number;
  errors: string[];
  duration: number;
}

interface SyncStatus {
  running: boolean;
  results: SyncResult[];
  totalErrors: string[];
  startedAt: string;
  completedAt?: string;
}

interface MarketplaceSyncResult {
  syncType: string;
  recordsFetched: number;
  duration: number;
}

interface MarketplaceSyncStatus {
  results?: MarketplaceSyncResult[];
}

interface TransactionImportResult {
  rowsProcessed?: number;
  shippingCostsUpdated?: number;
  feesUpdated?: number;
  feesInserted?: number;
  error?: string;
}

export default function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData>({
    clientId: '',
    clientSecret: '',
    refreshToken: '',
    marketplaceId: 'ATVPDKIKX0DER',
    lastSync: null,
    extensionApiKey: '',
    veeqo_api_key: '',
    airtable_api_key: '',
    profit_target_monthly: '',
  });
  const [veeqoTesting, setVeeqoTesting] = useState(false);
  const [veeqoSyncing, setVeeqoSyncing] = useState(false);
  const [veeqoResult, setVeeqoResult] = useState<{ ok?: boolean; success?: boolean; message?: string; error?: string; set?: number; setCents?: number; matched?: number; notFound?: number } | null>(null);
  const [binBusy, setBinBusy] = useState(false);
  const [binResult, setBinResult] = useState<{ success?: boolean; error?: string; preview?: boolean; flSkusWithBin?: number; matched?: number; toWrite?: number; written?: number; unchanged?: number; unmatched?: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [lookbackDays, setLookbackDays] = useState<string | number>(90);

  useEffect(() => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings) setSettings(prev => ({ ...prev, ...data.settings }));
      })
      .catch(() => {});
  }, []);

  // Poll sync status while syncing
  useEffect(() => {
    if (!syncing) return;
    const interval = setInterval(async () => {
      try {
        const res = await fetch('/api/sync');
        const data = await res.json();
        if (data.status) {
          setSyncStatus(data.status);
          if (!data.status.running) {
            setSyncing(false);
            // Refresh settings to get new lastSync
            const settingsRes = await fetch('/api/data/settings');
            const settingsData = await settingsRes.json();
            if (settingsData.settings) setSettings(prev => ({ ...prev, ...settingsData.settings }));
          }
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [syncing]);

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await fetch('/api/data/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      console.error('Failed to save settings:', err);
    }
    setSaving(false);
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/sync/test');
      const data = await res.json();
      setTestResult(data);
    } catch {
      setTestResult({ success: false, error: 'Network error' });
    }
    setTesting(false);
  }

  function generateExtensionKey() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    const key = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    setSettings(s => ({ ...s, extensionApiKey: key }));
  }

  // Persist current settings (so the server can read the key), then run fn.
  async function saveThen(fn: () => Promise<void>) {
    await fetch('/api/data/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
    });
    await fn();
  }

  async function veeqoTest() {
    setVeeqoTesting(true); setVeeqoResult(null);
    try {
      await saveThen(async () => {
        const res = await fetch('/api/sync/veeqo-shipping?test=1');
        setVeeqoResult(await res.json());
      });
    } catch (e) {
      setVeeqoResult({ ok: false, error: String(e) });
    }
    setVeeqoTesting(false);
  }

  async function veeqoSync() {
    setVeeqoSyncing(true); setVeeqoResult(null);
    try {
      await saveThen(async () => {
        const res = await fetch('/api/sync/veeqo-shipping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        setVeeqoResult(await res.json());
      });
    } catch (e) {
      setVeeqoResult({ success: false, error: String(e) });
    }
    setVeeqoSyncing(false);
  }

  async function pushBins(apply: boolean) {
    setBinBusy(true); setBinResult(null);
    try {
      await saveThen(async () => {
        const res = await fetch('/api/sync/veeqo-bins', { method: apply ? 'POST' : 'GET' });
        setBinResult(await res.json());
      });
    } catch (e) {
      setBinResult({ success: false, error: String(e) });
    }
    setBinBusy(false);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncStatus(null);
    try {
      let days = lookbackDays;
      if (lookbackDays === 'ytd') {
        const now = new Date();
        const jan1 = new Date(now.getFullYear(), 0, 1);
        days = Math.ceil((now.getTime() - jan1.getTime()) / 86400000);
      } else if (lookbackDays === 'all') {
        // Since 2021 — roughly 5+ years
        const now = new Date();
        const start = new Date('2021-01-01');
        days = Math.ceil((now.getTime() - start.getTime()) / 86400000);
      }
      await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays: Number(days) }),
      });
    } catch (err) {
      console.error('Failed to start sync:', err);
      setSyncing(false);
    }
  }

  const syncTypeLabels: Record<string, string> = {
    financial_events: 'Financial Events',
    orders: 'Orders',
    fba_inventory: 'FBA Inventory',
    catalog: 'Product Catalog',
    settlement_reports: 'Settlement Reports',
  };

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-text-tertiary mt-0.5">Configure your Amazon SP-API connection</p>
      </div>

      {/* SP-API Credentials */}
      <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
        <h2 className="text-md font-medium text-text-primary mb-4">SP-API Credentials</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
              Client ID
            </label>
            <input
              type="text"
              value={settings.clientId}
              onChange={e => setSettings(s => ({ ...s, clientId: e.target.value }))}
              placeholder="amzn1.application-oa2-client.xxxx"
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
            />
          </div>
          <div>
            <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
              Client Secret
            </label>
            <input
              type="password"
              value={settings.clientSecret}
              onChange={e => setSettings(s => ({ ...s, clientSecret: e.target.value }))}
              placeholder="amzn1.oa2-cs.v1.xxxx"
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
            />
          </div>
          <div>
            <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
              Refresh Token
            </label>
            <input
              type="password"
              value={settings.refreshToken}
              onChange={e => setSettings(s => ({ ...s, refreshToken: e.target.value }))}
              placeholder="Atzr|xxxx"
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
            />
          </div>
          <div>
            <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
              Marketplace
            </label>
            <select
              value={settings.marketplaceId}
              onChange={e => setSettings(s => ({ ...s, marketplaceId: e.target.value }))}
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
            >
              <option value="ATVPDKIKX0DER">Amazon.com (US)</option>
              <option value="A2EUQ1WTGCTBG2">Amazon.ca (Canada)</option>
              <option value="A1AM78C64UM0Y8">Amazon.com.mx (Mexico)</option>
            </select>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save Credentials'}
          </button>
          <button
            onClick={handleTest}
            disabled={testing || !settings.clientId}
            className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-default text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            <TestTube size={14} />
            {testing ? 'Testing...' : 'Test Connection'}
          </button>
          {saved && (
            <span className="flex items-center gap-1 text-sm text-positive">
              <CheckCircle size={14} /> Saved
            </span>
          )}
          {testResult?.success && (
            <span className="flex items-center gap-1 text-sm text-positive">
              <CheckCircle size={14} /> Connected
            </span>
          )}
          {testResult && !testResult.success && (
            <span className="flex items-center gap-1 text-sm text-negative">
              <XCircle size={14} /> Failed
            </span>
          )}
        </div>
        {testResult && !testResult.success && testResult.error && (
          <div className="mt-3 p-3 bg-negative-muted rounded-md text-xs text-negative font-mono break-all">
            {testResult.error}
          </div>
        )}
      </div>

      {/* Shipping Station Extension */}
      <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
        <h2 className="text-md font-medium text-text-primary mb-1">Shipping Station Extension</h2>
        <p className="text-xs text-text-tertiary mb-4">
          Shared key for the Chrome extension that overlays Flip Ledger ASIN/bin context inside Veeqo.
        </p>
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Extension API Key
          </label>
          <div className="flex gap-2">
            <input
              type="password"
              value={settings.extensionApiKey}
              onChange={e => setSettings(s => ({ ...s, extensionApiKey: e.target.value }))}
              placeholder="Generate a key and use the same value in the Chrome extension"
              className="flex-1 h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
            />
            <button
              onClick={generateExtensionKey}
              className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors"
            >
              <KeyRound size={14} />
              Generate
            </button>
          </div>
        </div>
        <div className="flex items-center gap-3 mt-5">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save Extension Key'}
          </button>
          {saved && (
            <span className="flex items-center gap-1 text-sm text-positive">
              <CheckCircle size={14} /> Saved
            </span>
          )}
        </div>
        <p className="text-[11px] text-text-tertiary mt-3 font-mono break-all">
          Endpoint: http://YOUR-FLIPLEDGER-IP:3000/api/extension/veeqo-context
        </p>
      </div>

      {/* Veeqo Shipping Costs */}
      <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
        <h2 className="text-md font-medium text-text-primary mb-1">Profit Target</h2>
        <p className="text-xs text-text-tertiary mb-4">
          Monthly anticipated-profit goal for purchases. The dashboard derives the day
          and week from it and shows ahead/behind pace (pro-rated by where you are in the
          month) plus an end-of-month projection. Leave blank to hide it.
        </p>
        <div className="mb-6 max-w-xs">
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">Monthly Profit Target ($)</label>
          <input
            type="number"
            min="0"
            value={settings.profit_target_monthly || ''}
            onChange={e => setSettings(s => ({ ...s, profit_target_monthly: e.target.value }))}
            placeholder="e.g. 6000"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>

        <h2 className="text-md font-medium text-text-primary mb-1">Airtable Purchases</h2>
        <p className="text-xs text-text-tertiary mb-4">
          Syncs your 💳 Orders table into the Incoming page hourly (on-order lots,
          overdue aging, receive flow). Create a personal access token at
          airtable.com/create/tokens with data.records:read + data.records:write
          scoped to the Products base.
        </p>
        <div className="mb-6">
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Airtable Personal Access Token
          </label>
          <input
            type="password"
            value={settings.airtable_api_key || ''}
            onChange={e => setSettings(s => ({ ...s, airtable_api_key: e.target.value }))}
            placeholder="pat..."
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>

        <h2 className="text-md font-medium text-text-primary mb-1">Veeqo Shipping Costs</h2>
        <p className="text-xs text-text-tertiary mb-4">
          Pulls each MFN order&apos;s label cost from the Veeqo API and fills its shipping cost
          (fill-empty only; runs daily in auto-sync). Get the key from Veeqo → Settings → Users → API access.
        </p>
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Veeqo API Key
          </label>
          <input
            type="password"
            value={settings.veeqo_api_key || ''}
            onChange={e => setSettings(s => ({ ...s, veeqo_api_key: e.target.value }))}
            placeholder="Paste your Veeqo API key"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
        <div className="flex items-center gap-3 mt-5 flex-wrap">
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
          >
            <Save size={14} />
            {saving ? 'Saving...' : 'Save Key'}
          </button>
          <button
            onClick={veeqoTest}
            disabled={veeqoTesting || !settings.veeqo_api_key}
            className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            {veeqoTesting ? 'Testing...' : 'Test Connection'}
          </button>
          <button
            onClick={veeqoSync}
            disabled={veeqoSyncing || !settings.veeqo_api_key}
            className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50"
          >
            {veeqoSyncing ? 'Syncing...' : 'Sync Shipping Now'}
          </button>
          {saved && (
            <span className="flex items-center gap-1 text-sm text-positive">
              <CheckCircle size={14} /> Saved
            </span>
          )}
        </div>
        {veeqoResult && (
          <div className={`mt-4 text-sm ${(veeqoResult.ok || veeqoResult.success) ? 'text-positive' : 'text-negative'}`}>
            {veeqoResult.error
              ? `Error: ${veeqoResult.error}`
              : veeqoResult.message
              ? veeqoResult.message
              : `Done — set ${veeqoResult.set ?? 0} orders ($${(((veeqoResult.setCents ?? 0)) / 100).toFixed(2)}); matched ${veeqoResult.matched ?? 0}, not found ${veeqoResult.notFound ?? 0}.`}
          </div>
        )}

        <div className="mt-5 pt-4 border-t border-border-subtle">
          <div className="text-xs font-medium uppercase tracking-wide text-text-tertiary mb-2">Push Bin Locations → Veeqo</div>
          <p className="text-xs text-text-tertiary mb-3">
            Writes each FlipLedger bin into Veeqo&apos;s product location (matched by SKU). Preview first; unmatched SKUs are reported, never guessed.
          </p>
          <div className="flex items-center gap-3 flex-wrap">
            <button onClick={() => pushBins(false)} disabled={binBusy || !settings.veeqo_api_key}
              className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50">
              {binBusy ? 'Working...' : 'Preview Bin Push'}
            </button>
            <button onClick={() => pushBins(true)} disabled={binBusy || !settings.veeqo_api_key || !(binResult && (binResult.toWrite ?? 0) > 0 && binResult.preview)}
              className="flex items-center gap-2 h-9 px-3 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50">
              Push Bins to Veeqo
            </button>
          </div>
          {binResult && (
            <div className={`mt-3 text-sm ${binResult.error ? 'text-negative' : 'text-text-secondary'}`}>
              {binResult.error
                ? `Error: ${binResult.error}`
                : binResult.preview
                ? `Preview — ${binResult.matched ?? 0} matched, ${binResult.toWrite ?? 0} to write, ${binResult.unchanged ?? 0} already correct, ${binResult.unmatched ?? 0} unmatched (of ${binResult.flSkusWithBin ?? 0} binned SKUs). Click "Push Bins" to apply.`
                : `Done — wrote ${binResult.written ?? 0} bins to Veeqo (${binResult.unchanged ?? 0} already correct, ${binResult.unmatched ?? 0} unmatched).`}
            </div>
          )}
        </div>
      </div>

      {/* Sync */}
      <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
        <h2 className="text-md font-medium text-text-primary mb-4">Data Sync</h2>

        <div className="flex items-center justify-between mb-4">
          <div>
            <div className="text-sm text-text-secondary">Last synced</div>
            <div className="text-sm font-mono text-text-tertiary mt-0.5">
              {settings.lastSync ? formatRelativeTime(settings.lastSync) : 'Never — no data synced yet'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={lookbackDays}
              onChange={e => {
                const v = e.target.value;
                setLookbackDays(v === 'ytd' || v === 'all' ? v : Number(v));
              }}
              className="h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary"
              disabled={syncing}
            >
              <option value={7}>Last 7 days</option>
              <option value={30}>Last 30 days</option>
              <option value={60}>Last 60 days</option>
              <option value={90}>Last 90 days</option>
              <option value={180}>Last 6 months</option>
              <option value="ytd">Year to Date</option>
              <option value={365}>Last year</option>
              <option value={730}>Last 2 years</option>
              <option value={1095}>Last 3 years</option>
              <option value={1825}>Last 5 years</option>
              <option value="all">All data (since 2021)</option>
            </select>
            <button
              onClick={handleSync}
              disabled={syncing || !settings.clientId}
              className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Syncing...' : 'Sync Now'}
            </button>
          </div>
        </div>

        {!settings.clientId && (
          <p className="text-xs text-text-tertiary">
            Enter and save your SP-API credentials above to enable syncing.
          </p>
        )}

        {/* Sync Progress */}
        {syncStatus && (
          <div className="mt-4 space-y-2">
            <div className="text-xs font-medium tracking-wide uppercase text-text-tertiary mb-2">
              {syncStatus.running ? 'Sync in progress...' : 'Last sync results'}
            </div>
            {syncStatus.results.map((result, i) => (
              <div key={i} className="flex items-center justify-between py-2 px-3 bg-bg-root rounded-md">
                <div className="flex items-center gap-2">
                  {result.errors.length > 0 ? (
                    <AlertCircle size={14} className="text-warning" />
                  ) : (
                    <CheckCircle size={14} className="text-positive" />
                  )}
                  <span className="text-sm text-text-primary">
                    {syncTypeLabels[result.syncType] || result.syncType}
                  </span>
                </div>
                <div className="flex items-center gap-4">
                  <span className="text-xs font-mono text-text-secondary">
                    {result.recordsFetched} records
                  </span>
                  <span className="text-xs font-mono text-text-tertiary">
                    {(result.duration / 1000).toFixed(1)}s
                  </span>
                </div>
              </div>
            ))}

            {syncStatus.totalErrors.length > 0 && (
              <div className="mt-3">
                <div className="text-xs font-medium text-warning mb-1">
                  {syncStatus.totalErrors.length} warning{syncStatus.totalErrors.length > 1 ? 's' : ''}
                </div>
                <div className="max-h-32 overflow-y-auto p-3 bg-warning-muted rounded-md text-xs text-warning font-mono space-y-1">
                  {syncStatus.totalErrors.slice(0, 10).map((err, i) => (
                    <div key={i}>{err}</div>
                  ))}
                  {syncStatus.totalErrors.length > 10 && (
                    <div>...and {syncStatus.totalErrors.length - 10} more</div>
                  )}
                </div>
              </div>
            )}

            {syncStatus.completedAt && (
              <div className="text-xs text-text-tertiary mt-2">
                Completed at {new Date(syncStatus.completedAt).toLocaleString()}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Ship-From Address */}
      <ShipFromSettings />

      {/* Walmart Credentials */}
      <WalmartSettings />

      {/* eBay Credentials */}
      <EbaySettings />

      {/* Informed Repricer */}
      <InformedSettings />

      {/* Transaction Report Import */}
      <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
        <h2 className="text-md font-medium text-text-primary mb-2">Import Transaction Report</h2>
        <p className="text-xs text-text-tertiary mb-4">
          Upload a Date Range Transaction Report from Seller Central (Payments → Reports Repository) to get exact fees and shipping costs.
        </p>
        <ImportTransactionReport />
      </div>

      {/* About */}
      <div className="bg-bg-surface border border-border-subtle rounded-lg p-6">
        <h2 className="text-md font-medium text-text-primary mb-4">About</h2>
        <div className="space-y-2 text-sm text-text-secondary">
          <p>FlipLedger connects to Amazon&apos;s Selling Partner API to pull your sales, fees, refunds, reimbursements, and inventory data.</p>
          <p>All data is stored locally in a SQLite database on your machine. Nothing is sent to any external server.</p>
          <p className="text-text-tertiary text-xs font-mono mt-3">Database: data/flipledger.db</p>
        </div>
      </div>
    </div>
  );
}

function ShipFromSettings() {
  const [fields, setFields] = useState({
    listing_ship_from_name: '',
    listing_ship_from_address_line1: '',
    listing_ship_from_city: '',
    listing_ship_from_state: '',
    listing_ship_from_postal_code: '',
    listing_ship_from_country_code: 'US',
    listing_ship_from_phone: '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings) {
          setFields(prev => ({
            listing_ship_from_name: data.settings.listing_ship_from_name || prev.listing_ship_from_name,
            listing_ship_from_address_line1: data.settings.listing_ship_from_address_line1 || prev.listing_ship_from_address_line1,
            listing_ship_from_city: data.settings.listing_ship_from_city || prev.listing_ship_from_city,
            listing_ship_from_state: data.settings.listing_ship_from_state || prev.listing_ship_from_state,
            listing_ship_from_postal_code: data.settings.listing_ship_from_postal_code || prev.listing_ship_from_postal_code,
            listing_ship_from_country_code: data.settings.listing_ship_from_country_code || 'US',
            listing_ship_from_phone: data.settings.listing_ship_from_phone || prev.listing_ship_from_phone,
          }));
        }
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    await fetch('/api/data/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  const inputClass = 'w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25';
  const labelClass = 'block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5';

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
      <h2 className="text-md font-medium text-text-primary mb-1">Ship-From Address</h2>
      <p className="text-xs text-text-tertiary mb-4">Used when creating FBA inbound shipments. Must match the address registered with your carrier account.</p>
      <div className="space-y-4">
        <div>
          <label className={labelClass}>Name / Company</label>
          <input
            type="text"
            value={fields.listing_ship_from_name}
            onChange={e => setFields(f => ({ ...f, listing_ship_from_name: e.target.value }))}
            placeholder="Rockstar Products LLC"
            className={inputClass}
          />
        </div>
        <div>
          <label className={labelClass}>Street Address</label>
          <input
            type="text"
            value={fields.listing_ship_from_address_line1}
            onChange={e => setFields(f => ({ ...f, listing_ship_from_address_line1: e.target.value }))}
            placeholder="123 Main St"
            className={inputClass}
          />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-1">
            <label className={labelClass}>City</label>
            <input
              type="text"
              value={fields.listing_ship_from_city}
              onChange={e => setFields(f => ({ ...f, listing_ship_from_city: e.target.value }))}
              placeholder="Chicago"
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>State</label>
            <input
              type="text"
              value={fields.listing_ship_from_state}
              onChange={e => setFields(f => ({ ...f, listing_ship_from_state: e.target.value }))}
              placeholder="IL"
              maxLength={2}
              className={inputClass}
            />
          </div>
          <div>
            <label className={labelClass}>ZIP Code</label>
            <input
              type="text"
              value={fields.listing_ship_from_postal_code}
              onChange={e => setFields(f => ({ ...f, listing_ship_from_postal_code: e.target.value }))}
              placeholder="60601"
              className={inputClass}
            />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelClass}>Country</label>
            <select
              value={fields.listing_ship_from_country_code}
              onChange={e => setFields(f => ({ ...f, listing_ship_from_country_code: e.target.value }))}
              className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
            >
              <option value="US">United States</option>
              <option value="CA">Canada</option>
              <option value="MX">Mexico</option>
            </select>
          </div>
          <div>
            <label className={labelClass}>Phone</label>
            <input
              type="tel"
              value={fields.listing_ship_from_phone}
              onChange={e => setFields(f => ({ ...f, listing_ship_from_phone: e.target.value }))}
              placeholder="555-555-5555"
              className={inputClass}
            />
          </div>
        </div>
      </div>
      <div className="flex items-center gap-3 mt-5">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50"
        >
          <Save size={14} />
          {saving ? 'Saving...' : 'Save Address'}
        </button>
        {saved && (
          <span className="flex items-center gap-1 text-sm text-positive">
            <CheckCircle size={14} /> Saved
          </span>
        )}
      </div>
    </div>
  );
}

function InformedSettings() {
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [hasSaved, setHasSaved] = useState(false);

  useEffect(() => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings?.informed_api_key) {
          setApiKey(data.settings.informed_api_key);
          setHasSaved(true);
        }
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    await fetch('/api/data/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ informed_api_key: apiKey.trim() }),
    });
    setSaving(false);
    setSaved(true);
    setHasSaved(!!apiKey.trim());
    setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
      <h2 className="text-md font-medium text-text-primary mb-2">Informed Repricer</h2>
      <p className="text-xs text-text-tertiary mb-4">
        API key from your Informed account (Integrations → API). Used to push per-unit buy cost when a batch closes, so the repricer respects your true cost floor.
      </p>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            API Key
          </label>
          <input
            type="password"
            value={apiKey}
            onChange={e => setApiKey(e.target.value)}
            placeholder="Paste your Informed API key"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50">
          <Save size={14} />
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved && <span className="flex items-center gap-1 text-sm text-positive"><CheckCircle size={14} /> Saved</span>}
        {!saved && hasSaved && <span className="flex items-center gap-1 text-sm text-text-tertiary"><CheckCircle size={14} /> Key stored</span>}
      </div>
    </div>
  );
}

function WalmartSettings() {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<MarketplaceSyncStatus | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings?.walmart_client_id) setClientId(data.settings.walmart_client_id);
        if (data.settings?.walmart_client_secret) setClientSecret(data.settings.walmart_client_secret);
        if (data.settings?.walmart_last_sync) setLastSync(data.settings.walmart_last_sync);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    await fetch('/api/data/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walmart_client_id: clientId, walmart_client_secret: clientSecret }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      await fetch('/api/sync/walmart', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays: 90 }),
      });
      // Poll for completion
      const poll = setInterval(async () => {
        const res = await fetch('/api/sync/walmart');
        const data = await res.json();
        if (!data.status.running) {
          clearInterval(poll);
          setSyncing(false);
          setSyncResult(data.status);
          setLastSync(new Date().toISOString());
        }
      }, 2000);
    } catch {
      setSyncing(false);
    }
  }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
      <h2 className="text-md font-medium text-text-primary mb-4">Walmart Marketplace</h2>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Client ID
          </label>
          <input
            type="text"
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Client Secret
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder="Your Walmart API client secret"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50">
          <Save size={14} />
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={handleSync} disabled={syncing || !clientId}
          className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-default text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50">
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync Walmart'}
        </button>
        {saved && <span className="flex items-center gap-1 text-sm text-positive"><CheckCircle size={14} /> Saved</span>}
      </div>

      {lastSync && (
        <div className="text-xs text-text-tertiary mt-3">
          Last synced: {formatRelativeTime(lastSync)}
        </div>
      )}

      {syncResult && (
        <div className="mt-3 space-y-1">
          {syncResult.results?.map((r, i) => (
            <div key={i} className="flex items-center justify-between py-1.5 px-3 bg-bg-root rounded-md text-xs">
              <span className="text-text-primary">{r.syncType.replace('walmart_', '')}</span>
              <span className="font-mono text-text-secondary">{r.recordsFetched} records ({(r.duration/1000).toFixed(1)}s)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EbaySettings() {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<MarketplaceSyncStatus | null>(null);
  const [lastSync, setLastSync] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings?.ebay_client_id) setClientId(data.settings.ebay_client_id);
        if (data.settings?.ebay_client_secret) setClientSecret(data.settings.ebay_client_secret);
        if (data.settings?.ebay_refresh_token) setRefreshToken(data.settings.ebay_refresh_token);
        if (data.settings?.ebay_last_sync) setLastSync(data.settings.ebay_last_sync);
      })
      .catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    await fetch('/api/data/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ebay_client_id: clientId, ebay_client_secret: clientSecret, ebay_refresh_token: refreshToken }),
    });
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 3000);
  }

  async function handleSync() {
    setSyncing(true);
    setSyncResult(null);
    try {
      await fetch('/api/sync/ebay', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lookbackDays: 90 }),
      });
      const poll = setInterval(async () => {
        const res = await fetch('/api/sync/ebay');
        const data = await res.json();
        if (!data.status.running) {
          clearInterval(poll);
          setSyncing(false);
          setSyncResult(data.status);
          setLastSync(new Date().toISOString());
        }
      }, 2000);
    } catch {
      setSyncing(false);
    }
  }

  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg p-6 mb-6">
      <h2 className="text-md font-medium text-text-primary mb-4">eBay Marketplace</h2>
      <div className="space-y-4">
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            App ID (Client ID)
          </label>
          <input
            type="text"
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            placeholder="Your eBay App ID"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Cert ID (Client Secret)
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={e => setClientSecret(e.target.value)}
            placeholder="Your eBay Cert ID"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
        </div>
        <div>
          <label className="block text-xs font-medium tracking-wide uppercase text-text-tertiary mb-1.5">
            Refresh Token
          </label>
          <input
            type="password"
            value={refreshToken}
            onChange={e => setRefreshToken(e.target.value)}
            placeholder="OAuth refresh token from User Tokens page"
            className="w-full h-9 px-3 bg-bg-input border border-border-default rounded-md text-sm text-text-primary placeholder-text-tertiary focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/25"
          />
          <p className="text-[11px] text-text-tertiary mt-1">Generate via User Tokens on developer.ebay.com. Refresh tokens last 18 months.</p>
        </div>
      </div>

      <div className="flex items-center gap-3 mt-5">
        <button onClick={handleSave} disabled={saving}
          className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors disabled:opacity-50">
          <Save size={14} />
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button onClick={handleSync} disabled={syncing || !clientId || !refreshToken}
          className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-default text-text-primary rounded-md text-sm font-medium hover:bg-bg-hover transition-colors disabled:opacity-50">
          <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Syncing...' : 'Sync eBay'}
        </button>
        {saved && <span className="flex items-center gap-1 text-sm text-positive"><CheckCircle size={14} /> Saved</span>}
      </div>

      {lastSync && (
        <div className="text-xs text-text-tertiary mt-3">
          Last synced: {formatRelativeTime(lastSync)}
        </div>
      )}

      {syncResult && (
        <div className="mt-3 space-y-1">
          {syncResult.results?.map((r, i) => (
            <div key={i} className="flex items-center justify-between py-1.5 px-3 bg-bg-root rounded-md text-xs">
              <span className="text-text-primary">{r.syncType.replace('ebay_', '')}</span>
              <span className="font-mono text-text-secondary">{r.recordsFetched} records ({(r.duration/1000).toFixed(1)}s)</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ImportTransactionReport() {
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<TransactionImportResult | null>(null);

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setImporting(true);
    setResult(null);

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/sync/import-transactions', { method: 'POST', body: formData });
      const data = await res.json();
      setResult(data);
    } catch (err) {
      setResult({ error: String(err) });
    }
    setImporting(false);
  }

  return (
    <div>
      <label className="flex items-center gap-2 h-9 px-4 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors cursor-pointer w-fit">
        <input type="file" accept=".csv,.tsv,.txt" onChange={handleImport} className="hidden" disabled={importing} />
        {importing ? 'Importing...' : 'Choose CSV File'}
      </label>
      {result && !result.error && (
        <div className="mt-3 p-3 bg-positive-muted rounded-md text-xs text-positive space-y-1">
          <div>Rows processed: {result.rowsProcessed}</div>
          <div>Shipping costs updated: {result.shippingCostsUpdated}</div>
          <div>Estimated fees replaced: {result.feesUpdated}</div>
          <div>New fees imported: {result.feesInserted}</div>
        </div>
      )}
      {result?.error && (
        <div className="mt-3 p-3 bg-negative-muted rounded-md text-xs text-negative">{result.error}</div>
      )}
    </div>
  );
}
