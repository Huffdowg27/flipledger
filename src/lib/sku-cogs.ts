/**
 * Extract COGS (in integer cents) from a structured SKU string.
 *
 * Recognized formats:
 *
 * LV_/ZTPC_ style (Airtable-sourced MFN listings):
 *   LV_SUPPLIER_DATE_COGS_PRICE_ROI_TYPE_NUM
 *   ZTPC_SUPPLIER_DATE_COGS_...
 *   Segment at index 3 (0-based, after 3rd underscore) is the COGS as dollars.
 *   e.g. LV_01FAFLIP_030226_22.5_52_3_P_212 → 2250 cents
 *
 * Returns 0 if no COGS can be extracted or the value is non-positive.
 *
 * Amazon may wrap a seller SKU in a global `amzn.gr.` prefix (e.g.
 * `amzn.gr.LV_01AFLIP_112025_17.9-JcSyVV-LN`). We strip that prefix first so the
 * embedded LV_/ZTPC_ cost is still recoverable. parseFloat tolerates Amazon's
 * trailing `-XXXX` suffix on the value segment.
 */
function unwrapAmazonGlobalSku(sku: string): string {
  return sku.startsWith('amzn.gr.') ? sku.slice('amzn.gr.'.length) : sku;
}

export function extractCogsFromSku(sku: string | null | undefined): number {
  if (!sku) return 0;

  const s = unwrapAmazonGlobalSku(sku);
  if (s.startsWith('LV_') || s.startsWith('ZTPC_')) {
    const parts = s.split('_');
    if (parts.length >= 4) {
      const val = parseFloat(parts[3]);
      if (Number.isFinite(val) && val > 0) return Math.round(val * 100);
    }
  }

  return 0;
}

/** True if this SKU uses a recognized COGS-encoding format. */
export function isCogsEncodedSku(sku: string | null | undefined): boolean {
  if (!sku) return false;
  const s = unwrapAmazonGlobalSku(sku);
  return s.startsWith('LV_') || s.startsWith('ZTPC_');
}
