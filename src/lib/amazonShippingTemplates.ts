import type Database from 'better-sqlite3';

export interface AmazonShippingTemplate {
  key: string;
  name: string;
}

export interface AmazonShippingTemplateCache {
  templates: AmazonShippingTemplate[];
  marketplaceId: string | null;
  fetchedAt: string | null;
}

export const AMAZON_SHIPPING_TEMPLATE_CACHE_KEY = 'amazon_shipping_templates';
const CACHE_KEY = AMAZON_SHIPPING_TEMPLATE_CACHE_KEY;

// Push paths refresh the cache when it's older than this before validating
// template names. Amazon remains the final arbiter either way — an unknown
// name is rejected and the push fails closed.
export const AMAZON_SHIPPING_TEMPLATE_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;

export function isAmazonShippingTemplateCacheStale(
  cache: AmazonShippingTemplateCache,
  now: number = Date.now(),
): boolean {
  if (!cache.fetchedAt) return true;
  const fetchedAt = new Date(cache.fetchedAt).getTime();
  return !Number.isFinite(fetchedAt) || now - fetchedAt > AMAZON_SHIPPING_TEMPLATE_CACHE_FRESH_MS;
}

function cleanTemplate(template: unknown): AmazonShippingTemplate | null {
  if (!template || typeof template !== 'object') return null;
  const row = template as Record<string, unknown>;
  const key = typeof row.key === 'string' ? row.key.trim() : '';
  const name = typeof row.name === 'string' ? row.name.trim() : '';
  if (!key && !name) return null;
  return { key: key || name, name: name || key };
}

export function parseAmazonShippingTemplateCache(raw: string | null | undefined): AmazonShippingTemplateCache {
  if (!raw) return { templates: [], marketplaceId: null, fetchedAt: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { templates: [], marketplaceId: null, fetchedAt: null };
  }
  const obj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  const templates = Array.isArray(obj.templates)
    ? obj.templates.map(cleanTemplate).filter((t): t is AmazonShippingTemplate => t != null)
    : [];
  return {
    templates,
    marketplaceId: typeof obj.marketplaceId === 'string' ? obj.marketplaceId : null,
    fetchedAt: typeof obj.fetchedAt === 'string' ? obj.fetchedAt : null,
  };
}

export function loadAmazonShippingTemplateCache(db: Database.Database): AmazonShippingTemplateCache {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?')
    .get(CACHE_KEY) as { value: string } | undefined;
  return parseAmazonShippingTemplateCache(row?.value);
}

export function resolveAmazonShippingTemplate(
  value: string | null | undefined,
  templates: AmazonShippingTemplate[],
): AmazonShippingTemplate | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) return null;
  return templates.find((template) => template.key === trimmed || template.name === trimmed) ?? null;
}

export function resolveAmazonShippingTemplateName(
  value: string | null | undefined,
  templates: AmazonShippingTemplate[],
): string | null {
  return resolveAmazonShippingTemplate(value, templates)?.name ?? null;
}

/**
 * The value Amazon's Listings API expects for merchant_shipping_group is the
 * template's ENUM KEY (an id like "0eb5ed64-…"), NOT the display name. Sending
 * the display name is rejected with error 90244. Push paths must use this.
 */
export function resolveAmazonShippingTemplateKey(
  value: string | null | undefined,
  templates: AmazonShippingTemplate[],
): string | null {
  return resolveAmazonShippingTemplate(value, templates)?.key ?? null;
}

export function shippingTemplateValidationError(
  requested: string | null | undefined,
  templates: AmazonShippingTemplate[],
): string | null {
  const trimmed = typeof requested === 'string' ? requested.trim() : '';
  if (!trimmed) {
    return 'Select an Amazon shipping template before pushing MFN listings.';
  }
  if (templates.length === 0) {
    return 'No synced Amazon shipping templates are available. Sync shipping templates in Settings before pushing MFN listings.';
  }
  if (!resolveAmazonShippingTemplateName(trimmed, templates)) {
    return `Shipping template "${trimmed}" is not in the synced Amazon shipping templates. Sync templates in Settings or choose a current template before pushing.`;
  }
  return null;
}

export function isMerchantShippingGroupIssue(issue: unknown): boolean {
  if (!issue || typeof issue !== 'object') return false;
  const row = issue as Record<string, unknown>;
  const attributeNames = Array.isArray(row.attributeNames)
    ? row.attributeNames.map((name) => String(name).toLowerCase())
    : [];
  const text = [
    row.code,
    row.message,
    row.attributeName,
    row.attribute,
    ...attributeNames,
  ].filter((part): part is string | number => typeof part === 'string' || typeof part === 'number')
    .map((part) => String(part).toLowerCase())
    .join(' ');

  return text.includes('merchant_shipping_group')
    || text.includes('merchant shipping group')
    || text.includes('shipping template');
}

// Fail-closed marker: when Amazon rejects merchant_shipping_group we do NOT
// retry without the template (a live offer with the wrong shipping template
// charges the wrong shipping). The row stays INVALID with this actionable issue.
export function makeTemplateRejectedIssue(templateName: string) {
  return {
    code: 'FLIPLEDGER_TEMPLATE_REJECTED',
    message: `Amazon rejected merchant_shipping_group for "${templateName}". Nothing was pushed without the template. Sync shipping templates in Settings, pick a current template, and push again.`,
    severity: 'ERROR',
    attributeNames: ['merchant_shipping_group'],
  };
}
