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
 */
export function extractCogsFromSku(sku: string | null | undefined): number {
  if (!sku) return 0;

  if (sku.startsWith('LV_') || sku.startsWith('ZTPC_')) {
    const parts = sku.split('_');
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
  return sku.startsWith('LV_') || sku.startsWith('ZTPC_');
}
