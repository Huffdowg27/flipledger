const DEFAULT_BASE_URL = 'http://localhost:3000';

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

async function getConfig() {
  const stored = await chrome.storage.local.get({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
  });
  return {
    baseUrl: normalizeBaseUrl(stored.baseUrl),
    apiKey: String(stored.apiKey || '').trim(),
  };
}

async function lookupMany(lookups) {
  const config = await getConfig();
  if (!config.baseUrl || !config.apiKey) {
    return {
      ok: false,
      error: 'Configure the Flip Ledger URL and extension key in extension options.',
    };
  }

  const response = await fetch(`${config.baseUrl}/api/extension/veeqo-context`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-FlipLedger-Extension-Key': config.apiKey,
    },
    body: JSON.stringify({ lookups }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: data.error || `Flip Ledger returned HTTP ${response.status}` };
  }
  return { ok: true, data };
}

async function testConnection() {
  const config = await getConfig();
  if (!config.baseUrl || !config.apiKey) {
    return { ok: false, error: 'Missing URL or extension key.' };
  }

  const response = await fetch(`${config.baseUrl}/api/extension/veeqo-context?health=1`, {
    headers: {
      'X-FlipLedger-Extension-Key': config.apiKey,
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, error: data.error || `Flip Ledger returned HTTP ${response.status}` };
  }
  return { ok: true, data };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'lookupMany') {
    lookupMany(Array.isArray(message.lookups) ? message.lookups : [])
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === 'testConnection') {
    testConnection()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});
