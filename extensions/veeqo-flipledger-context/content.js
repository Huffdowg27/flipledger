const ORDER_ID_RE = /\b\d{3}-\d{7}-\d{7}\b/;
const SKU_RE = /\b(?:MF_)?LV_[A-Z0-9._-]+/i;
const CONTEXT_ATTR = 'data-flipledger-context';
const LOOKUP_ATTR = 'data-flipledger-lookup-key';
const STATUS_ATTR = 'data-flipledger-lookup-status';

let scanTimer = null;

function scheduleScan() {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(scanRows, 800);
}

function cleanTextFromNode(node) {
  const clone = node.cloneNode(true);
  clone.querySelectorAll(`[${CONTEXT_ATTR}]`).forEach(el => el.remove());
  return clone.textContent || '';
}

function normalizeSku(value) {
  return String(value || '').replace(/\s+/g, '').trim();
}

function findHeaderIndex(row, labels) {
  const table = row.closest('table');
  if (!table) return -1;

  const headers = Array.from(table.querySelectorAll('thead th, thead [role="columnheader"]'));
  if (headers.length === 0) return -1;

  return headers.findIndex(header => {
    const text = (header.textContent || '').trim().toLowerCase();
    return labels.some(label => text === label || text.includes(label));
  });
}

function getCells(row) {
  const cells = Array.from(row.querySelectorAll(':scope > td, :scope > [role="cell"]'));
  if (cells.length > 0) return cells;
  return Array.from(row.children);
}

function extractOrderId(row) {
  const text = cleanTextFromNode(row);
  return text.match(ORDER_ID_RE)?.[0] || null;
}

function extractSku(row) {
  const cells = getCells(row);
  const skuIndex = findHeaderIndex(row, ['sku']);
  if (skuIndex >= 0 && cells[skuIndex]) {
    const skuText = normalizeSku(cleanTextFromNode(cells[skuIndex]));
    if (skuText) return skuText;
  }

  for (const cell of cells) {
    const cellText = normalizeSku(cleanTextFromNode(cell));
    if (SKU_RE.test(cellText)) return cellText.match(SKU_RE)?.[0] || null;
  }

  const rowText = cleanTextFromNode(row).replace(/\s+/g, ' ');
  return rowText.match(SKU_RE)?.[0] || null;
}

function getInjectionTarget(row) {
  const cells = getCells(row);
  const skuIndex = findHeaderIndex(row, ['sku']);
  if (skuIndex >= 0 && cells[skuIndex]) return cells[skuIndex];

  const itemIndex = findHeaderIndex(row, ['items', 'item']);
  if (itemIndex >= 0 && cells[itemIndex]) return cells[itemIndex];

  return row;
}

function candidateRows() {
  const rows = Array.from(document.querySelectorAll('tbody tr, tr, [role="row"]'));
  return rows.filter(row => {
    if (row.querySelector('th, [role="columnheader"]')) return false;
    // Cheap candidacy test on raw text (no cloneNode). Our injected context nodes
    // never contain an order-id pattern, so they can't cause a false positive.
    return ORDER_ID_RE.test(row.textContent || '');
  });
}

function setContextNode(row, className, html, title) {
  const target = getInjectionTarget(row);
  let node = target.querySelector(`[${CONTEXT_ATTR}]`);
  if (!node) {
    node = document.createElement('div');
    node.setAttribute(CONTEXT_ATTR, 'true');
    target.appendChild(node);
  }
  node.className = `fl-veeqo-context ${className}`;
  node.title = title || '';
  node.innerHTML = html;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderLoading(row) {
  setContextNode(row, 'fl-loading', 'Flip Ledger: loading...', '');
}

function renderError(row, message) {
  setContextNode(row, 'fl-error', `Flip Ledger: ${escapeHtml(message)}`, message);
}

function renderResult(row, result) {
  if (!result) {
    renderError(row, 'no lookup result');
    return;
  }

  if (result.status === 'matched' && result.match) {
    const asin = result.match.asin || 'No ASIN';
    const bin = result.match.displayBin || 'No bin saved';
    const title = result.message || `Matched by ${result.matchStrategy || 'Flip Ledger'}`;
    setContextNode(
      row,
      result.match.displayBin ? 'fl-found' : 'fl-missing-bin',
      `<span>ASIN <strong>${escapeHtml(asin)}</strong></span><span>BIN <strong>${escapeHtml(bin)}</strong></span>`,
      title
    );
    return;
  }

  const statusText = {
    order_not_found: 'No Flip Ledger order',
    sku_not_found: 'SKU not matched',
    ambiguous: 'Multiple items - need SKU',
    invalid_request: 'Invalid lookup',
  }[result.status] || 'No match';

  setContextNode(row, 'fl-missing', `Flip Ledger: ${escapeHtml(statusText)}`, result.message || statusText);
}

async function sendLookup(lookups) {
  return chrome.runtime.sendMessage({ type: 'lookupMany', lookups });
}

async function scanRowsInner() {
  const rows = candidateRows();
  const byLookupKey = new Map();
  const lookups = [];

  for (const row of rows) {
    const orderId = extractOrderId(row);
    if (!orderId) continue;

    const sku = extractSku(row);
    const key = `${orderId}::${sku || ''}`;
    if (row.getAttribute(LOOKUP_ATTR) === key && row.getAttribute(STATUS_ATTR) === 'done') {
      continue;
    }

    row.setAttribute(LOOKUP_ATTR, key);
    row.setAttribute(STATUS_ATTR, 'loading');
    renderLoading(row);

    if (!byLookupKey.has(key)) {
      byLookupKey.set(key, { orderId, sku, rows: [] });
      lookups.push({ orderId, sku });
    }
    byLookupKey.get(key).rows.push(row);
  }

  if (lookups.length === 0) return;

  let response;
  try {
    response = await sendLookup(lookups);
  } catch (error) {
    for (const row of rows) {
      if (row.getAttribute(STATUS_ATTR) === 'loading') {
        row.setAttribute(STATUS_ATTR, 'done');
        renderError(row, String(error));
      }
    }
    return;
  }

  if (!response?.ok) {
    for (const row of rows) {
      if (row.getAttribute(STATUS_ATTR) === 'loading') {
        row.setAttribute(STATUS_ATTR, 'done');
        renderError(row, response?.error || 'lookup failed');
      }
    }
    return;
  }

  const results = Array.isArray(response.data?.results) ? response.data.results : [];
  const resultByKey = new Map(results.map(result => [`${result.orderId}::${result.sku || ''}`, result]));

  for (const [key, entry] of byLookupKey.entries()) {
    const result = resultByKey.get(key);
    for (const row of entry.rows) {
      row.setAttribute(STATUS_ATTR, 'done');
      renderResult(row, result);
    }
  }
}

const OBSERVE_OPTS = { childList: true, subtree: true };
const observerTarget = document.body || document.documentElement;
const observer = new MutationObserver(scheduleScan);

// Pause the observer while WE mutate the DOM so our own injected nodes don't
// retrigger a scan — that self-feedback loop (plus Veeqo's constant SPA
// re-renders) is what pegged the tab's CPU. Veeqo changes during a scan just
// schedule the next one once we reconnect.
async function scanRows() {
  observer.disconnect();
  try {
    await scanRowsInner();
  } finally {
    observer.observe(observerTarget, OBSERVE_OPTS);
  }
}

observer.observe(observerTarget, OBSERVE_OPTS);
scheduleScan();
