const DEFAULT_BASE_URL = 'http://localhost:3000';

const baseUrlInput = document.getElementById('baseUrl');
const apiKeyInput = document.getElementById('apiKey');
const statusEl = document.getElementById('status');

function setStatus(message, type = '') {
  statusEl.textContent = message;
  statusEl.className = type;
}

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
}

async function loadOptions() {
  const stored = await chrome.storage.local.get({
    baseUrl: DEFAULT_BASE_URL,
    apiKey: '',
  });
  baseUrlInput.value = stored.baseUrl || DEFAULT_BASE_URL;
  apiKeyInput.value = stored.apiKey || '';
}

async function saveOptions() {
  await chrome.storage.local.set({
    baseUrl: normalizeBaseUrl(baseUrlInput.value),
    apiKey: apiKeyInput.value.trim(),
  });
  setStatus('Saved.', 'ok');
}

async function testConnection() {
  await saveOptions();
  setStatus('Testing...', '');
  const response = await chrome.runtime.sendMessage({ type: 'testConnection' });
  if (response?.ok) {
    setStatus('Connected to Flip Ledger.', 'ok');
  } else {
    setStatus(response?.error || 'Connection failed.', 'error');
  }
}

document.getElementById('save').addEventListener('click', saveOptions);
document.getElementById('test').addEventListener('click', testConnection);

loadOptions().catch(error => setStatus(String(error), 'error'));
