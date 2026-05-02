/**
 * Smart MSKU generator for the listing tool.
 *
 * Produces SKUs in the format: {supplier}-{productSlug}-{buyCostInt}
 *
 * Examples:
 *   generateMSKU('Woot', 'Bowers & Wilkins Px8 S2 Wireless Headphones', 279)
 *     → 'woot-BowersWilkinsPx8-279'
 *   generateMSKU('Walmart', 'Nintendo Neon Purple/Neon Orange Joy-Con (L-R) - Switch', 55)
 *     → 'wm-NintendoNeonPurple-55'
 */

// Known supplier abbreviations. Extend this map as needed.
const SUPPLIER_ABBREVIATIONS: Record<string, string> = {
  'walmart': 'wm',
  'walmart.com': 'wm',
  'target': 'tgt',
  'best buy': 'bb',
  'bestbuy': 'bb',
  'amazon': 'amz',
  'amazon.com': 'amz',
  'woot': 'woot',
  'woot.com': 'woot',
  'costco': 'cost',
  'kohls': 'kohls',
  "kohl's": 'kohls',
  'gamestop': 'gs',
  'ebay': 'eb',
  'ebay.com': 'eb',
  'home depot': 'hd',
  'lowes': 'lowes',
  "lowe's": 'lowes',
  'barnes and noble': 'bn',
  'barnes & noble': 'bn',
  'macys': 'macy',
  "macy's": 'macy',
  'sams club': 'sams',
  "sam's club": 'sams',
  'bjs': 'bjs',
  "bj's": 'bjs',
  'five below': '5bel',
  'dollar tree': 'dt',
  'dollar general': 'dg',
  'marshalls': 'mar',
  'tjmaxx': 'tjm',
  'ross': 'ross',
  'burlington': 'burl',
  'ulta': 'ulta',
  'sephora': 'seph',
};

/** Abbreviate a supplier name, falling back to first 4 lowercase alpha chars. */
export function abbreviateSupplier(supplier: string | null | undefined): string {
  if (!supplier) return '';
  const trimmed = supplier.trim().toLowerCase();
  if (!trimmed) return '';

  // Exact match first
  if (SUPPLIER_ABBREVIATIONS[trimmed]) return SUPPLIER_ABBREVIATIONS[trimmed];

  // Fuzzy contains match (e.g. "Walmart Store #1234" → wm)
  for (const [key, abbr] of Object.entries(SUPPLIER_ABBREVIATIONS)) {
    if (trimmed.includes(key)) return abbr;
  }

  // Fallback: first 4 alpha chars
  return trimmed.replace(/[^a-z]/g, '').slice(0, 4) || 'unk';
}

const STOPWORDS = new Set([
  'with', 'for', 'and', 'the', 'an', 'of', 'to', 'from', 'in', 'at', 'on',
  'by', 'w', 'w/', '&', '-', 'a', 'or', 'via', 'per', 'as', 'new', 'brand',
  'edition', 'series', 'version', 'original', 'pack', 'set', 'piece',
]);

/**
 * Turn a long Amazon product title into a compact CamelCase slug.
 * Takes 3-4 distinctive words, strips filler/stopwords/parens/specs.
 */
export function slugifyProductName(name: string | null | undefined, maxWords: number = 3, maxLen: number = 22): string {
  if (!name) return '';

  // Strip parenthetical content (specs, model numbers, etc.)
  let s = name.replace(/\([^)]*\)/g, ' ');

  // Truncate at first comma (usually separates name from feature list)
  s = s.split(',')[0];

  // Tokenize on whitespace, hyphens, underscores, slashes
  const tokens = s.split(/[\s\-_/]+/)
    .map((t) => t.replace(/[^a-zA-Z0-9]/g, ''))
    .filter((t) => t.length > 0);

  // Dedupe while preserving order (avoids "NeonPurpleNeonOrange")
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (seen.has(lower)) continue;
    if (STOPWORDS.has(lower)) continue;
    // Skip single non-alpha tokens (e.g. size "12", "5pk")
    if (/^\d+$/.test(t) && deduped.length === 0) continue;
    seen.add(lower);
    deduped.push(t);
  }

  const chosen = deduped.slice(0, maxWords);
  const camel = chosen
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase())
    .join('');

  return camel.slice(0, maxLen);
}

/** Floor a dollar amount to an integer, returning '0' for zero/invalid. */
export function formatBuyCost(buyPriceDollars: number | string | null | undefined): string {
  const n = typeof buyPriceDollars === 'string' ? parseFloat(buyPriceDollars) : Number(buyPriceDollars ?? 0);
  if (!Number.isFinite(n) || n <= 0) return '0';
  return String(Math.floor(n));
}

/**
 * Generate an MSKU from supplier, product name, and buy cost.
 * Skips empty parts gracefully.
 */
export function generateMSKU(
  supplier: string | null | undefined,
  productName: string | null | undefined,
  buyPriceDollars: number | string | null | undefined,
  fallbackAsin?: string | null
): string {
  const parts: string[] = [];

  const sup = abbreviateSupplier(supplier);
  if (sup) parts.push(sup);

  const slug = slugifyProductName(productName);
  if (slug) parts.push(slug);

  const cost = formatBuyCost(buyPriceDollars);
  if (cost !== '0') parts.push(cost);

  // If we have at least supplier + slug (or slug + cost), join with dashes
  if (parts.length >= 2) return parts.join('-');

  // If we only have a slug, return just that
  if (slug) return slug;

  // Otherwise fall back to ASIN-YYMMDD
  if (fallbackAsin) {
    const d = new Date();
    const stamp = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    return `${fallbackAsin}-${stamp}`;
  }

  return '';
}
