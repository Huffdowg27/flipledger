// Column-mapped buy-list CSV parser.
//
// Unlike the InventoryLab parser (inventorylab-fbm.ts), which decodes
// quantity/cost/price out of an encoded Seller-Sku string, this parser reads
// explicit columns from an arbitrary CSV (e.g. an Airtable export of received
// inventory). Headers are auto-detected by name with a generous alias map, and
// every field can be remapped by the caller before the final parse.
//
// Run 1: parse + preview only. No DB writes. No SP-API calls.
// All money is integer cents internally; "$30.00"/"1,234.50" style strings are
// stripped of $ and , before parsing. Float math never persists.

import { splitCsv } from './inventorylab-fbm';

export type FieldKey =
  | 'asin'
  | 'msku'
  | 'productName'
  | 'quantity'
  | 'cost'
  | 'listPrice'
  | 'supplier'
  | 'purchaseDate'
  | 'condition'
  | 'shippingTemplate';

export type ColumnMapping = Record<FieldKey, string | null>;

export interface ParsedRow {
  rowIndex: number;            // 0-based index into the body
  asin: string;
  msku: string;
  productName: string;
  quantity: number;
  costCents: number;           // per-unit buy cost
  listPriceCents: number;      // per-unit list price
  supplier: string | null;
  purchaseDate: string | null; // YYYY-MM-DD
  condition: string;           // listing_batch_items condition code
  shippingTemplate: string | null;
  warnings: string[];
  errors: string[];
}

export interface ParseResult {
  headers: string[];
  columnMapping: ColumnMapping;
  rows: ParsedRow[];
  totals: {
    rowCount: number;
    validRowCount: number;
    totalUnits: number;
    totalCostCents: number;
    totalListValueCents: number;
  };
  globalErrors: string[];
}

// Every field key the UI can map, in display order. Required ones are enforced.
export const FIELD_KEYS: FieldKey[] = [
  'asin', 'msku', 'productName', 'quantity', 'cost', 'listPrice',
  'supplier', 'purchaseDate', 'condition', 'shippingTemplate',
];

export const FIELD_LABELS: Record<FieldKey, string> = {
  asin: 'ASIN',
  msku: 'MSKU / Seller SKU',
  productName: 'Product / Title',
  quantity: 'Quantity',
  cost: 'Cost / Unit',
  listPrice: 'List Price',
  supplier: 'Supplier',
  purchaseDate: 'Purchase Date',
  condition: 'Condition',
  shippingTemplate: 'Shipping Template',
};

const REQUIRED_FIELDS: FieldKey[] = ['asin', 'msku', 'quantity', 'cost', 'listPrice'];

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Header-name → field-key aliases. Drawn from the InventoryLab parser and the
// Airtable upload-list normalizer (mfn-upload-list.ts) so a typical Airtable
// "received items" export maps on the first try.
const HEADER_ALIASES: Record<string, FieldKey> = {
  'asin': 'asin',
  'product-id': 'asin',

  'msku': 'msku',
  'seller sku': 'msku',
  'sellersku': 'msku',
  'mfsku': 'msku',
  'merchant sku': 'msku',
  'sku': 'msku',

  'product': 'productName',
  'title': 'productName',
  'name': 'productName',
  'product name': 'productName',

  'quantity': 'quantity',
  'qty': 'quantity',
  'qty received': 'quantity',
  'recived qty': 'quantity',
  'received qty': 'quantity',
  'order qty': 'quantity',

  'cost': 'cost',
  'cost/unit': 'cost',
  'cost per unit': 'cost',
  'unit cost': 'cost',
  'buy cost': 'cost',
  'buycost': 'cost',
  'cost price': 'cost',
  'cogs final': 'cost',

  'list price': 'listPrice',
  'salesprice': 'listPrice',
  'sales price': 'listPrice',
  'price': 'listPrice',
  'expected sell price': 'listPrice',
  'max price': 'listPrice',

  'supplier': 'supplier',

  'purchase date': 'purchaseDate',
  'purchaseddate': 'purchaseDate',
  'dateordered': 'purchaseDate',
  'date ordered': 'purchaseDate',
  'date purchased': 'purchaseDate',

  'condition': 'condition',
  'item condition': 'condition',
  'item-condition': 'condition',

  'shipping template': 'shippingTemplate',
  'mfn shipping template': 'shippingTemplate',
  'merchant_shipping_group_name': 'shippingTemplate',
};

export function detectColumnMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {
    asin: null, msku: null, productName: null, quantity: null, cost: null,
    listPrice: null, supplier: null, purchaseDate: null, condition: null,
    shippingTemplate: null,
  };
  for (const h of headers) {
    const key = HEADER_ALIASES[norm(h)];
    if (key && !mapping[key]) mapping[key] = h;
  }
  return mapping;
}

function parseMoney(s: string | undefined): number | null {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[$,\s]/g, '');
  const v = parseFloat(cleaned);
  if (!Number.isFinite(v)) return null;
  return Math.round(v * 100);
}

function parseQty(s: string | undefined): number | null {
  if (s == null) return null;
  const trimmed = String(s).trim();
  if (!trimmed) return null;
  // Tolerate "5", "5.0", "5 units"; reject anything with no leading integer.
  const m = trimmed.match(/^(\d+)(?:\.0+)?/);
  if (!m) return null;
  const v = parseInt(m[1], 10);
  return Number.isFinite(v) ? v : null;
}

// Accepts MM/DD/YYYY, M/D/YYYY, MM/DD/YY, YYYY-MM-DD. Returns YYYY-MM-DD | null.
function parseDate(s: string | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (!t) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  let yyyy = m[3];
  if (yyyy.length === 2) yyyy = `20${yyyy}`;
  return `${yyyy}-${mm}-${dd}`;
}

// Normalize free-text condition to a listing_batch_items condition code.
function normalizeCondition(s: string | undefined): string {
  const t = norm(s || '');
  if (!t || t === 'new' || t === 'newitem' || t === 'new item' || t === 'brand new') return 'NewItem';
  if (t.includes('like new')) return 'UsedLikeNew';
  if (t.includes('very good')) return 'UsedVeryGood';
  if (t.includes('acceptable')) return 'UsedAcceptable';
  if (t.includes('good')) return 'UsedGood';
  // Pass through anything already in code form, else default to NewItem.
  if (/^(NewItem|UsedLikeNew|UsedVeryGood|UsedGood|UsedAcceptable)$/.test((s || '').trim())) {
    return (s as string).trim();
  }
  return 'NewItem';
}

function cellAt(row: string[], headers: string[], name: string | null): string {
  if (!name) return '';
  const idx = headers.findIndex(h => h === name);
  if (idx < 0) return '';
  return (row[idx] ?? '').trim();
}

// Parse a buy-list CSV. `override` lets the caller pin specific field→header
// mappings (from the column-mapping UI); unset keys fall back to auto-detect.
export function parseBuyListCsv(csvText: string, override?: Partial<ColumnMapping>): ParseResult {
  const globalErrors: string[] = [];
  const matrix = splitCsv(csvText);
  if (matrix.length === 0) {
    return {
      headers: [],
      columnMapping: detectColumnMapping([]),
      rows: [],
      totals: { rowCount: 0, validRowCount: 0, totalUnits: 0, totalCostCents: 0, totalListValueCents: 0 },
      globalErrors: ['CSV is empty'],
    };
  }

  const headers = matrix[0].map(h => h.trim());
  const detected = detectColumnMapping(headers);
  const mapping: ColumnMapping = { ...detected };
  if (override) {
    for (const key of FIELD_KEYS) {
      if (Object.prototype.hasOwnProperty.call(override, key)) {
        mapping[key] = override[key] ?? null;
      }
    }
  }

  for (const key of REQUIRED_FIELDS) {
    if (!mapping[key]) globalErrors.push(`Unmapped required column: ${FIELD_LABELS[key]}`);
  }

  const rows: ParsedRow[] = [];
  let validRowCount = 0;
  let totalUnits = 0, totalCostCents = 0, totalListCents = 0;

  for (let r = 1; r < matrix.length; r++) {
    const raw = matrix[r];
    if (raw.every(c => c.trim() === '')) continue;

    const errors: string[] = [];
    const warnings: string[] = [];

    const asin = cellAt(raw, headers, mapping.asin).toUpperCase();
    const msku = cellAt(raw, headers, mapping.msku);
    const productName = cellAt(raw, headers, mapping.productName);
    const supplier = cellAt(raw, headers, mapping.supplier) || null;
    const shippingTemplate = cellAt(raw, headers, mapping.shippingTemplate) || null;
    const condition = normalizeCondition(cellAt(raw, headers, mapping.condition));

    const quantity = parseQty(cellAt(raw, headers, mapping.quantity));
    const costCents = parseMoney(cellAt(raw, headers, mapping.cost));
    const listCents = parseMoney(cellAt(raw, headers, mapping.listPrice));
    const purchaseDate = parseDate(cellAt(raw, headers, mapping.purchaseDate));

    if (!asin) errors.push('Missing ASIN');
    if (!msku) errors.push('Missing MSKU');
    if (quantity == null || quantity <= 0) errors.push('Invalid quantity');
    if (costCents == null || costCents <= 0) errors.push('Invalid cost');
    if (listCents == null || listCents <= 0) errors.push('Invalid list price');
    if (mapping.purchaseDate && cellAt(raw, headers, mapping.purchaseDate) && !purchaseDate) {
      warnings.push('Unrecognized purchase date — will default to today');
    }

    const parsedRow: ParsedRow = {
      rowIndex: r - 1,
      asin,
      msku,
      productName,
      quantity: quantity ?? 0,
      costCents: costCents ?? 0,
      listPriceCents: listCents ?? 0,
      supplier,
      purchaseDate,
      condition,
      shippingTemplate,
      warnings,
      errors,
    };
    rows.push(parsedRow);

    if (errors.length === 0) {
      validRowCount += 1;
      totalUnits += parsedRow.quantity;
      totalCostCents += parsedRow.costCents * parsedRow.quantity;
      totalListCents += parsedRow.listPriceCents * parsedRow.quantity;
    }
  }

  return {
    headers,
    columnMapping: mapping,
    rows,
    totals: {
      rowCount: rows.length,
      validRowCount,
      totalUnits,
      totalCostCents,
      totalListValueCents: totalListCents,
    },
    globalErrors,
  };
}
