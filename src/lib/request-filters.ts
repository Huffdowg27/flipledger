export const MARKETPLACE_VALUES = ['amazon', 'walmart', 'ebay', 'paypal'] as const;

export type Marketplace = (typeof MARKETPLACE_VALUES)[number];

export type MarketplaceFilterResult =
  | { ok: true; marketplace: Marketplace | null }
  | { ok: false };

/**
 * Validate the marketplace query parameter at the HTTP boundary.
 * Missing, blank, and `all` mean no marketplace filter.
 */
export function parseMarketplaceFilter(raw: string | null): MarketplaceFilterResult {
  if (raw === null || raw === '' || raw === 'all') {
    return { ok: true, marketplace: null };
  }

  if ((MARKETPLACE_VALUES as readonly string[]).includes(raw)) {
    return { ok: true, marketplace: raw as Marketplace };
  }

  return { ok: false };
}

/** Strict YYYY-MM-DD validation without JavaScript Date overflow normalization. */
export function isIsoCalendarDate(raw: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}
