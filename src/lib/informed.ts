/**
 * Informed Repricer cost push.
 *
 * On batch close we send each SKU's per-unit buy cost to Informed so the
 * repricer respects our true cost. Cost is informational (COST column) — we do
 * NOT touch MIN_PRICE/MAX_PRICE, so this can never move a price floor on its own.
 *
 * Verified API shape (2026-05-31):
 *   POST https://api.informedrepricer.com/v1/feed
 *     header  x-api-key: <key>
 *     header  Content-Type: text/csv
 *     body    CSV: SKU,COST,CURRENCY,CREATED_DATE
 *   -> { FeedSubmissionID, Status: "Pending" }
 *   GET  https://api.informedrepricer.com/v1/feed/submissions/{id}
 *   -> { Status, SuccessCount, ErrorCount, ErrorMessage, ... }
 */
import type Database from 'better-sqlite3';

const FEED_URL = 'https://api.informedrepricer.com/v1/feed';

export interface InformedPushResult {
  ok: boolean;
  skipped?: string;
  skuCount?: number;
  feedSubmissionId?: string;
  status?: string;
  error?: string;
}

/**
 * Build a SKU -> per-unit buy cost (cents) map for a batch.
 * MFN lots live in inventory_ledger (buy_price cents); FBA items live in
 * listing_batch_items (buy_price_cents). A batch is one channel, but we read
 * both so the helper is channel-agnostic. Last write wins on SKU collision.
 */
function collectCosts(db: Database.Database, batchId: number): Map<string, number> {
  const costs = new Map<string, number>();

  const ledger = db
    .prepare(
      `SELECT sku, buy_price AS cents FROM inventory_ledger
       WHERE batch_id = ? AND sku IS NOT NULL AND sku <> '' AND buy_price > 0`
    )
    .all(batchId) as { sku: string; cents: number }[];
  for (const r of ledger) costs.set(r.sku, r.cents);

  const items = db
    .prepare(
      `SELECT sku, buy_price_cents AS cents FROM listing_batch_items
       WHERE batch_id = ? AND sku IS NOT NULL AND sku <> '' AND buy_price_cents > 0`
    )
    .all(batchId) as { sku: string; cents: number }[];
  for (const r of items) costs.set(r.sku, r.cents);

  return costs;
}

function buildCsv(costs: Map<string, number>): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const lines = ['SKU,COST,CURRENCY,CREATED_DATE'];
  for (const [sku, cents] of costs) {
    const cost = (cents / 100).toFixed(2);
    lines.push(`${sku},${cost},USD,${date}`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Push a closed batch's per-unit costs to Informed. Best-effort: never throws —
 * a failure here must not block a batch from closing. Returns a result the
 * caller can log.
 */
export async function pushBatchCostToInformed(
  db: Database.Database,
  batchId: number
): Promise<InformedPushResult> {
  try {
    const row = db
      .prepare(`SELECT value FROM settings WHERE key = 'informed_api_key'`)
      .get() as { value: string } | undefined;
    const apiKey = row?.value?.trim();
    if (!apiKey) return { ok: false, skipped: 'no-api-key' };

    const costs = collectCosts(db, batchId);
    if (costs.size === 0) return { ok: false, skipped: 'no-skus-with-cost' };

    const res = await fetch(FEED_URL, {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'Content-Type': 'text/csv', accept: 'application/json' },
      body: buildCsv(costs),
    });

    const data = (await res.json().catch(() => ({}))) as {
      FeedSubmissionID?: string;
      Status?: string;
      message?: string;
    };

    if (!res.ok) {
      return { ok: false, skuCount: costs.size, error: data?.message || `HTTP ${res.status}` };
    }

    return {
      ok: true,
      skuCount: costs.size,
      feedSubmissionId: data.FeedSubmissionID,
      status: data.Status,
    };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
