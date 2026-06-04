/**
 * Derive the sourcing supplier code from a SKU/MSKU.
 *
 * SKUs encode the source as the alphabetic token after an optional layout
 * prefix and an optional leading sourcer number. Examples:
 *   LV_01WAL_040726_...        → WAL    (after prefix LV_ + number 01)
 *   ZTPC_04WOOT_...            → WOOT
 *   MF_LV_01WAL_...           → WAL
 *   LV_KEHE_102325_...        → KEHE   (no leading number)
 *   01KOH_20250723_...        → KOH    (no prefix)
 *   SFLIP-090123-42-ASIN-...  → SFLIP  (hyphen-delimited)
 *   SFLIP_20230603_...        → SFLIP
 *   01FAFLIP_X_21753_0.01     → FAFLIP
 *
 * Returns the uppercased supplier code, or null when none is encoded
 * (e.g. opaque numeric SKUs like "1070145738", or update lots "LV_UPD_...").
 */

// Layout prefixes that sit BEFORE the supplier token. Longest first so
// MF_LV_ strips before LV_.
const PREFIXES = ['MF_LV_', 'LVMF_', 'LV_', 'ZTPC_', 'IF_', 'RL_', 'MF_', 'MF-'];

// Tokens that are not real suppliers.
const NON_SUPPLIER = new Set(['UPD', 'X', 'MF', 'LV', 'ZTPC', 'IF']);

// Canonicalize variant spellings of the same source to one code. WALGREENS is
// deliberately NOT mapped to WAL — it's a different store.
const ALIASES: Record<string, string> = {
  WALMART: 'WAL',
  KOHLS: 'KOH',
  TARGET: 'TARG',
  SYNCFLIPS: 'SYNCFLIP',
  HOLLI: 'HOL',
};

export function parseSupplier(sku: string | null | undefined): string | null {
  if (!sku) return null;
  let s = sku.trim();
  if (!s) return null;

  // Strip a known layout prefix (case-insensitive), once.
  const upper = s.toUpperCase();
  for (const p of PREFIXES) {
    if (upper.startsWith(p)) {
      s = s.slice(p.length);
      break;
    }
  }

  // First NON-EMPTY segment (handles leading-underscore SKUs like _02JNB_...).
  const seg = s.split(/[_-]/).find(Boolean) ?? '';
  // Drop a leading sourcer number (e.g. "01WAL" → "WAL").
  let code = seg.replace(/^\d+/, '').toUpperCase();

  if (code.length < 2) return null;
  if (!/^[A-Z][A-Z0-9'&]*$/.test(code)) return null;
  if (NON_SUPPLIER.has(code)) return null;
  code = ALIASES[code] ?? code;
  return code;
}

/**
 * Optional friendly names for the most common codes. Unknown codes just show
 * the raw code — the search/grouping works regardless.
 */
export const SUPPLIER_NAMES: Record<string, string> = {
  WAL: 'Walmart',
  KOH: "Kohl's",
  WOOT: 'Woot',
  BBW: 'Bath & Body Works',
  ADI: 'Adidas',
  TARG: 'Target',
  SEPH: 'Sephora',
  KEHE: 'KeHE',
  BELK: 'Belk',
  DSW: 'DSW',
  COLU: 'Columbia',
  PUM: 'Puma',
  IHERB: 'iHerb',
  VIT: 'Vitacost',
  YC: 'Yankee Candle',
  RC: 'Replay & Catcher',
  RCFLIP: 'Replay & Catcher (Flip)',
  FAFLIP: 'Flip Alert',
  SFLIP: 'S Flip List',
  AFLIP: 'Amazon Flip',
  HFLIP: 'H Flip List',
};

export function supplierLabel(code: string): string {
  return SUPPLIER_NAMES[code] ? `${SUPPLIER_NAMES[code]} (${code})` : code;
}
