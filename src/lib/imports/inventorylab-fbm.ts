// InventoryLab FBM buy-list CSV parser.
//
// Run 1: parse + preview only. No DB writes. No SP-API calls.
//
// Header set we expect (case-insensitive, BOM-tolerant):
//   Seller Sku, IL Upload, DateOrdered, UPC, Product, Supplier, Cost,
//   SalesPrice, FulfillmentType, Min Price 20%, Max Price, ASIN,
//   FBM Shipping Estimate, Shipping Template
//
// All money is integer cents internally. The Cost/SalesPrice columns arrive as
// "$30.00"-style strings; the parser strips $ and , before parsing.

export type FieldKey =
  | 'sellerSku'
  | 'dateOrdered'
  | 'upc'
  | 'product'
  | 'supplier'
  | 'cost'
  | 'salesPrice'
  | 'fulfillmentType'
  | 'asin'
  | 'fbmShippingEstimate'
  | 'shippingTemplate';

export type ColumnMapping = Record<FieldKey, string | null>;

export interface SkuParsed {
  supplier: string;
  date: string;            // YYYY-MM-DD
  costCents: number;
  listPriceCents: number;
  quantity: number;
  flag: 'B' | 'P' | null;
  sequence: string;
}

export interface ParsedRow {
  rowIndex: number;            // 0-based index into the body
  rawSku: string;
  asin: string;
  productName: string;
  upc: string | null;
  supplier: string | null;
  fulfillmentType: string | null;
  shippingTemplate: string | null;
  quantity: number;            // unit count for this line
  costCents: number;           // per-unit cost
  listPriceCents: number;      // per-unit list price
  estimatedShipCents: number;  // per-unit shipping estimate
  purchaseDate: string | null; // YYYY-MM-DD; prefers DateOrdered, falls back to SKU
  skuParsed: SkuParsed | null;
  warnings: string[];
  errors: string[];
}

export interface ParseResult {
  headers: string[];
  columnMapping: ColumnMapping;
  rows: ParsedRow[];
  totals: {
    rowCount: number;
    totalUnits: number;
    totalCostCents: number;
    totalListValueCents: number;
    totalEstimatedShippingCents: number;
  };
  globalErrors: string[];
}

// Minimal RFC4180-ish CSV split: quoted fields can contain commas; "" inside
// a quoted field is a literal quote. Handles \r\n, \n, \r line breaks.
export function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  // Strip leading UTF-8 BOM if present
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cur += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cur += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ',') { row.push(cur); cur = ''; i++; continue; }
    if (ch === '\r') {
      // swallow \r\n as one break
      row.push(cur); cur = ''; rows.push(row); row = [];
      if (text[i + 1] === '\n') i += 2; else i++;
      continue;
    }
    if (ch === '\n') {
      row.push(cur); cur = ''; rows.push(row); row = [];
      i++; continue;
    }
    cur += ch; i++;
  }
  // last cell
  if (cur.length > 0 || row.length > 0) { row.push(cur); rows.push(row); }
  // Drop trailing fully-empty rows
  while (rows.length > 0 && rows[rows.length - 1].every(c => c.trim() === '')) {
    rows.pop();
  }
  return rows;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Default header-name → field-key map. Match is case- and whitespace-insensitive.
const DEFAULT_HEADER_MAP: Record<string, FieldKey> = {
  'seller sku':              'sellerSku',
  'msku':                    'sellerSku',
  'dateordered':             'dateOrdered',
  'date ordered':            'dateOrdered',
  'purchase date':           'dateOrdered',
  'upc':                     'upc',
  'product':                 'product',
  'title':                   'product',
  'supplier':                'supplier',
  'cost':                    'cost',
  'cost/unit':               'cost',
  'salesprice':              'salesPrice',
  'sales price':             'salesPrice',
  'list price':              'salesPrice',
  'fulfillmenttype':         'fulfillmentType',
  'fulfillment type':        'fulfillmentType',
  'asin':                    'asin',
  'fbm shipping estimate':   'fbmShippingEstimate',
  'shipping estimate':       'fbmShippingEstimate',
  'shipping template':       'shippingTemplate',
  'mfn shipping template':   'shippingTemplate',
};

export function detectColumnMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    sellerSku: null, dateOrdered: null, upc: null, product: null,
    supplier: null, cost: null, salesPrice: null, fulfillmentType: null,
    asin: null, fbmShippingEstimate: null, shippingTemplate: null,
  };
  for (const h of headers) {
    const key = DEFAULT_HEADER_MAP[norm(h)];
    if (key && !mapping[key]) mapping[key] = h;
  }
  return mapping;
}

// Strip "$" and "," then parse. Returns null on empty/invalid.
function parseMoney(s: string | undefined): number | null {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[$,\s]/g, '');
  const v = parseFloat(cleaned);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

function parseIntStrict(s: string | undefined): number | null {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  if (!/^-?\d+$/.test(trimmed)) return null;
  const v = parseInt(trimmed, 10);
  return Number.isFinite(v) ? v : null;
}

// Accepts MM/DD/YYYY, M/D/YYYY, MM/DD/YY, YYYY-MM-DD. Returns YYYY-MM-DD or null.
function parseDateOrdered(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  let yyyy = m[3];
  if (yyyy.length === 2) yyyy = `20${yyyy}`;
  return `${yyyy}-${mm}-${dd}`;
}

// SKU format: {LV|MF_LV}_{SUPPLIER}_{DATE}_{COST}_{LIST}_{QTY}_{B|P?}_{SEQ}
// Parsed right-to-left so 6-digit (MMDDYY) and 8-digit (MMDDYYYY) DATE
// variants are both handled.
export function parseSku(sku: string): SkuParsed | null {
  if (!sku) return null;
  let body: string;
  if (sku.startsWith('MF_LV_')) body = sku.slice(6);
  else if (sku.startsWith('LV_'))  body = sku.slice(3);
  else return null;

  const parts = body.split('_');
  if (parts.length < 5) return null;

  let i = parts.length - 1;
  if (!/^\d+$/.test(parts[i])) return null;
  const sequence = parts[i];
  i--;

  let flag: 'B' | 'P' | null = null;
  if (parts[i] === 'B' || parts[i] === 'P') { flag = parts[i] as 'B' | 'P'; i--; }
  if (i < 3) return null;

  const qty = parseInt(parts[i--], 10);
  if (!Number.isFinite(qty) || qty <= 0) return null;

  const listPrice = parseFloat(parts[i--]);
  if (!Number.isFinite(listPrice) || listPrice <= 0) return null;

  const cost = parseFloat(parts[i--]);
  if (!Number.isFinite(cost) || cost <= 0) return null;

  const ds = parts[i--];
  if (!/^\d{6}$/.test(ds) && !/^\d{8}$/.test(ds)) return null;
  let date: string;
  if (ds.length === 6) {
    date = `20${ds.slice(4, 6)}-${ds.slice(0, 2)}-${ds.slice(2, 4)}`;
  } else {
    date = `${ds.slice(4, 8)}-${ds.slice(0, 2)}-${ds.slice(2, 4)}`;
  }

  // Supplier = everything left, joined with _ (handles supplier codes that
  // contained underscores, though InventoryLab SKUs typically don't).
  const supplier = parts.slice(0, i + 1).join('_');

  return {
    supplier,
    date,
    costCents: Math.round(cost * 100),
    listPriceCents: Math.round(listPrice * 100),
    quantity: qty,
    flag,
    sequence,
  };
}

function get(row: string[], headers: string[], name: string | null): string {
  if (!name) return '';
  const idx = headers.findIndex(h => h === name);
  if (idx < 0) return '';
  return (row[idx] ?? '').trim();
}

export function parseFbmCsv(csvText: string): ParseResult {
  const globalErrors: string[] = [];
  const matrix = splitCsv(csvText);
  if (matrix.length === 0) {
    return {
      headers: [],
      columnMapping: detectColumnMapping([]),
      rows: [],
      totals: { rowCount: 0, totalUnits: 0, totalCostCents: 0, totalListValueCents: 0, totalEstimatedShippingCents: 0 },
      globalErrors: ['CSV is empty'],
    };
  }
  const headers = matrix[0].map(h => h.trim());
  const mapping = detectColumnMapping(headers);

  // Required columns for a useful preview
  const required: Array<[FieldKey, string]> = [
    ['sellerSku', 'Seller Sku'], ['asin', 'ASIN'], ['cost', 'Cost'],
    ['salesPrice', 'SalesPrice'],
  ];
  for (const [k, label] of required) {
    if (!mapping[k]) globalErrors.push(`Missing required column: ${label}`);
  }

  const rows: ParsedRow[] = [];
  let totalUnits = 0, totalCostCents = 0, totalListCents = 0, totalShipCents = 0;

  for (let r = 1; r < matrix.length; r++) {
    const raw = matrix[r];
    // Skip fully-empty rows (already trimmed in splitCsv, but be defensive)
    if (raw.every(c => c.trim() === '')) continue;

    const errors: string[] = [];
    const warnings: string[] = [];

    const rawSku = get(raw, headers, mapping.sellerSku);
    const asin = get(raw, headers, mapping.asin).toUpperCase();
    const productName = get(raw, headers, mapping.product);
    const upc = get(raw, headers, mapping.upc) || null;
    const supplierCol = get(raw, headers, mapping.supplier) || null;
    const fulfillmentType = get(raw, headers, mapping.fulfillmentType) || null;
    const shippingTemplate = get(raw, headers, mapping.shippingTemplate) || null;
    const dateOrderedRaw = get(raw, headers, mapping.dateOrdered);
    const costRaw = get(raw, headers, mapping.cost);
    const listRaw = get(raw, headers, mapping.salesPrice);
    const shipRaw = get(raw, headers, mapping.fbmShippingEstimate);

    const skuParsed = parseSku(rawSku);
    const costCents = parseMoney(costRaw);
    const listCents = parseMoney(listRaw);
    const shipCents = parseMoney(shipRaw) ?? 0;

    if (!rawSku) errors.push('Missing Seller Sku');
    if (!asin) errors.push('Missing ASIN');
    if (costCents == null || costCents <= 0) errors.push('Invalid cost');
    if (listCents == null || listCents <= 0) errors.push('Invalid list price');

    // Quantity: extracted from Seller Sku per spec. If unparseable, error.
    let quantity = 0;
    if (skuParsed && skuParsed.quantity > 0) {
      quantity = skuParsed.quantity;
    } else if (rawSku) {
      errors.push('Invalid quantity (could not extract from Seller Sku)');
    }

    // Purchase date: prefer DateOrdered, fall back to SKU-encoded date.
    const dateOrdered = parseDateOrdered(dateOrderedRaw);
    const purchaseDate = dateOrdered ?? skuParsed?.date ?? null;

    // FulfillmentType validation
    if (fulfillmentType) {
      const ft = fulfillmentType.toUpperCase();
      if (ft !== 'FBM' && ft !== 'MFN') {
        warnings.push(`Unexpected FulfillmentType "${fulfillmentType}" (expected FBM or MFN)`);
      }
    } else if (mapping.fulfillmentType) {
      warnings.push('FulfillmentType is blank');
    }

    // SKU vs column discrepancies
    if (skuParsed) {
      if (costCents != null && skuParsed.costCents !== costCents) {
        warnings.push(`SKU cost ($${(skuParsed.costCents / 100).toFixed(2)}) differs from Cost column ($${(costCents / 100).toFixed(2)})`);
      }
      if (listCents != null && skuParsed.listPriceCents !== listCents) {
        warnings.push(`SKU list price ($${(skuParsed.listPriceCents / 100).toFixed(2)}) differs from SalesPrice column ($${(listCents / 100).toFixed(2)})`);
      }
      if (dateOrdered && skuParsed.date && dateOrdered !== skuParsed.date) {
        warnings.push(`SKU date (${skuParsed.date}) differs from DateOrdered (${dateOrdered})`);
      }
      if (supplierCol && supplierCol.trim() && skuParsed.supplier && supplierCol.trim() !== skuParsed.supplier) {
        warnings.push(`Supplier column "${supplierCol}" differs from SKU supplier code "${skuParsed.supplier}"`);
      }
    }

    const parsedRow: ParsedRow = {
      rowIndex: r - 1,
      rawSku,
      asin,
      productName,
      upc,
      supplier: supplierCol,
      fulfillmentType,
      shippingTemplate,
      quantity,
      costCents: costCents ?? 0,
      listPriceCents: listCents ?? 0,
      estimatedShipCents: shipCents,
      purchaseDate,
      skuParsed,
      warnings,
      errors,
    };
    rows.push(parsedRow);

    // Roll totals only for rows that are fundamentally usable (have a qty).
    if (errors.length === 0) {
      totalUnits += quantity;
      totalCostCents += (costCents ?? 0) * quantity;
      totalListCents += (listCents ?? 0) * quantity;
      totalShipCents += shipCents * quantity;
    }
  }

  return {
    headers,
    columnMapping: mapping,
    rows,
    totals: {
      rowCount: rows.length,
      totalUnits,
      totalCostCents,
      totalListValueCents: totalListCents,
      totalEstimatedShippingCents: totalShipCents,
    },
    globalErrors,
  };
}
