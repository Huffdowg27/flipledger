/**
 * Veeqo "Shipping Report" CSV → per-order label cost importer (parser half).
 *
 * Veeqo is where MFN labels are actually bought, so this CSV is the authoritative
 * source for out-of-pocket shipping cost on merchant-fulfilled orders — the gap
 * that Amazon settlement reports leave (labels bought outside Amazon Buy Shipping,
 * or before settlement posts). The `Order ID` column is the Amazon order number,
 * which maps 1:1 to FlipLedger `orders.order_id`.
 *
 * We only import rows that have a real label cost. FBA rows (Carrier "Other",
 * empty Total Label Cost) carry no out-of-pocket cost and are skipped.
 *
 * All money is integer cents. The client preview is never trusted — the route
 * re-parses with this same function server-side.
 */

export interface VeeqoShipRow {
  orderId: string;
  costCents: number;
  carrier: string;
  service: string;
  shippedDate: string | null; // YYYY-MM-DD or null
  trackingId: string | null;
  rowIndex: number; // 1-based data row (excludes header)
}

export interface ParsedVeeqoShipping {
  rows: VeeqoShipRow[]; // only rows with a positive label cost
  skippedNoCost: number; // rows with no label cost (FBA / Carrier=Other)
  nonUsdCurrency: string[]; // any currency codes seen that weren't USD
  globalErrors: string[];
}

const REQUIRED_HEADERS = ['Order ID', 'Total Label Cost'];

/** RFC-4180-ish line splitter: handles double-quoted fields with embedded commas. */
function splitCsvLine(line: string): string[] {
  const cols: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; } // escaped quote
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      cols.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  cols.push(cur);
  return cols.map((c) => c.trim());
}

/** "6.98" → 698, "1,234.50" → 123450, "" → null, "0"/"0.00" → null. */
function parseCostCents(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[$,]/g, '').trim();
  if (!cleaned) return null;
  const val = parseFloat(cleaned);
  if (!Number.isFinite(val) || val <= 0) return null;
  return Math.round(val * 100);
}

/** "2026-06-08 09:18:55" or "2026-06-08" → "2026-06-08"; junk → null. */
function parseShippedDate(s: string): string | null {
  if (!s) return null;
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

export function parseVeeqoShippingCsv(text: string): ParsedVeeqoShipping {
  const result: ParsedVeeqoShipping = {
    rows: [],
    skippedNoCost: 0,
    nonUsdCurrency: [],
    globalErrors: [],
  };

  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    result.globalErrors.push('CSV is empty');
    return result;
  }

  const headers = splitCsvLine(lines[0]);
  const idx = (name: string) => headers.findIndex((h) => h.toLowerCase() === name.toLowerCase());

  for (const h of REQUIRED_HEADERS) {
    if (idx(h) === -1) result.globalErrors.push(`Missing required column: "${h}"`);
  }
  if (result.globalErrors.length > 0) return result;

  const iOrder = idx('Order ID');
  const iCost = idx('Total Label Cost');
  const iCarrier = idx('Carrier');
  const iService = idx('Service');
  const iDate = idx('Shipped Date');
  const iTracking = idx('Tracking ID');
  const iCurrency = idx('Currency');
  const currencies = new Set<string>();

  for (let j = 1; j < lines.length; j++) {
    const cols = splitCsvLine(lines[j]);
    const orderId = (cols[iOrder] || '').trim();
    const costCents = parseCostCents(cols[iCost] || '');

    if (costCents == null) {
      result.skippedNoCost++;
      continue;
    }
    if (!orderId) {
      // A cost with no order id can't be attributed — surface it, don't silently drop.
      result.globalErrors.push(`Row ${j}: has a label cost but no Order ID`);
      continue;
    }

    const currency = iCurrency >= 0 ? (cols[iCurrency] || '').trim().toUpperCase() : '';
    if (currency && currency !== 'USD') currencies.add(currency);

    result.rows.push({
      orderId,
      costCents,
      carrier: iCarrier >= 0 ? (cols[iCarrier] || '').trim() : '',
      service: iService >= 0 ? (cols[iService] || '').trim() : '',
      shippedDate: iDate >= 0 ? parseShippedDate(cols[iDate] || '') : null,
      trackingId: iTracking >= 0 ? (cols[iTracking] || '').trim() || null : null,
      rowIndex: j,
    });
  }

  result.nonUsdCurrency = Array.from(currencies);
  return result;
}
