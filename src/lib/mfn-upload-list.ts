export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface MfnUploadListRow {
  airtableRecordId: string;
  title: string;
  asin: string;
  sku: string;
  quantity: number;
  priceCents: number | null;
  costCents: number | null;
  conditionCode: string;
  addDelete: string;
  fulfillmentCenterId: string;
  shippingTemplate: string;
  mfnChecked: boolean;
  received: boolean;
  alreadyUploaded: boolean;
  issueFlag: boolean;
  blockingReasons: string[];
}

export interface MfnUploadListResult {
  ready: MfnUploadListRow[];
  blocked: MfnUploadListRow[];
  summary: {
    totalRows: number;
    readyRows: number;
    blockedRows: number;
    totalReadyQty: number;
    totalReadyCostCents: number;
    totalReadyRevenueCents: number;
  };
}

const SELLER_SKU_KEYS = ['Seller Sku', '\ufeffSeller Sku', 'MFSKU', 'Merchant SKU'];

function firstField(fields: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (fields[key] !== undefined && fields[key] !== null && fields[key] !== '') return fields[key];
  }
  return undefined;
}

function asText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const maybe = value as { text?: unknown; label?: unknown; url?: unknown; name?: unknown };
    return asText(maybe.text ?? maybe.label ?? maybe.name ?? maybe.url ?? '');
  }
  return '';
}

function asBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = asText(value).toLowerCase();
  return ['true', 'yes', 'y', '1', 'checked', 'mfn'].includes(text);
}

function asInt(value: unknown, fallback = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  const parsed = parseInt(asText(value).replace(/[^0-9-]/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function dollarsToCents(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.round(value * 100);
  const text = asText(value).replace(/[$,]/g, '');
  if (!text) return null;
  const parsed = parseFloat(text);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function validateRow(row: Omit<MfnUploadListRow, 'blockingReasons'>): string[] {
  const reasons: string[] = [];
  if (!row.mfnChecked) reasons.push('MFN is not checked');
  if (!row.received) reasons.push('Not marked received');
  if (row.alreadyUploaded) reasons.push('Already marked uploaded');
  if (row.issueFlag) reasons.push('Issue/damage flag present');
  if (!row.asin) reasons.push('Missing ASIN / product-id');
  if (!row.sku) reasons.push('Missing seller SKU');
  if (row.quantity <= 0) reasons.push('Missing quantity');
  if (row.priceCents == null || row.priceCents <= 0) reasons.push('Missing sales price');
  if (!row.conditionCode) reasons.push('Missing item condition');
  return reasons;
}

export function normalizeAirtableMfnRow(record: AirtableRecord): MfnUploadListRow {
  const fields = record.fields ?? {};
  const rowBase = {
    airtableRecordId: record.id,
    title: asText(firstField(fields, ['Product', 'Title', 'Name'])),
    asin: asText(firstField(fields, ['ASIN', 'Asin', 'product-id'])),
    sku: asText(firstField(fields, SELLER_SKU_KEYS)),
    quantity: asInt(firstField(fields, ['quantity', 'Qty Received', 'Recived QTY', 'Order QTY']), 0),
    priceCents: dollarsToCents(firstField(fields, ['SalesPrice', 'Expected Sell Price', 'Max Price', 'price'])),
    costCents: dollarsToCents(firstField(fields, ['Cost', 'Unit Cost', 'COGS Final'])),
    conditionCode: asText(firstField(fields, ['item-condition', 'Item Condition'])) || '11',
    addDelete: asText(firstField(fields, ['add-delete'])) || 'a',
    fulfillmentCenterId: asText(firstField(fields, ['fulfillment-center-id'])) || 'DEFAULT',
    shippingTemplate: asText(firstField(fields, ['Shipping Template', 'merchant_shipping_group_name'])),
    mfnChecked: asBool(firstField(fields, ['MFN', 'IL Upload MF', 'FulfillmentType'])),
    received: asBool(firstField(fields, ['Received'])) || asInt(firstField(fields, ['Recived QTY', 'Qty Received']), 0) > 0,
    alreadyUploaded: asBool(firstField(fields, ['Uploaded to Seller Central?', 'IL Upload MF'])) && asBool(firstField(fields, ['Uploaded to Seller Central?'])),
    issueFlag: asBool(firstField(fields, ['Issue Flag', 'Damaged', 'Returns/ Damaged'])),
  } satisfies Omit<MfnUploadListRow, 'blockingReasons'>;

  return {
    ...rowBase,
    blockingReasons: validateRow(rowBase),
  };
}

export function buildMfnUploadList(rows: MfnUploadListRow[]): MfnUploadListResult {
  const ready = rows.filter(row => row.blockingReasons.length === 0);
  const blocked = rows.filter(row => row.blockingReasons.length > 0);
  return {
    ready,
    blocked,
    summary: {
      totalRows: rows.length,
      readyRows: ready.length,
      blockedRows: blocked.length,
      totalReadyQty: ready.reduce((sum, row) => sum + row.quantity, 0),
      totalReadyCostCents: ready.reduce((sum, row) => sum + (row.costCents ?? 0) * row.quantity, 0),
      totalReadyRevenueCents: ready.reduce((sum, row) => sum + (row.priceCents ?? 0) * row.quantity, 0),
    },
  };
}

const INVENTORY_LOADER_HEADERS = [
  'sku',
  'product-id',
  'product-id-type',
  'price',
  'item-condition',
  'quantity',
  'add-delete',
  'fulfillment-center-id',
  'merchant_shipping_group_name',
];

function csvCell(value: string | number | null | undefined): string {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildInventoryLoaderCsv(rows: MfnUploadListRow[]): string {
  const lines = [INVENTORY_LOADER_HEADERS.join(',')];
  for (const row of rows) {
    lines.push([
      row.sku,
      row.asin,
      '1',
      row.priceCents == null ? '' : (row.priceCents / 100).toFixed(2),
      row.conditionCode,
      row.quantity,
      row.addDelete,
      row.fulfillmentCenterId,
      row.shippingTemplate,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}
