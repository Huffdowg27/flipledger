import type Database from 'better-sqlite3';

export interface InboundPlanSummary {
  inboundPlanId: string;
  name: string;
  status: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  marketplaceIds?: string[];
}

export interface InboundPlanManifestItem {
  msku: string;
  quantity: number;
}

export type InboundPlanRecoveryMatch =
  | { kind: 'none' }
  | { kind: 'found'; plan: InboundPlanSummary }
  | { kind: 'ambiguous'; plans: InboundPlanSummary[] };

const AMAZON_INBOUND_PLAN_NAME_LIMIT = 40;

export function buildInboundPlanName(batchId: number, batchName: string): string {
  const prefix = `FL-${batchId}-`;
  const readable = batchName
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^\x20-\x7E]/g, '');
  const suffixLength = Math.max(0, AMAZON_INBOUND_PLAN_NAME_LIMIT - prefix.length);
  return `${prefix}${readable.slice(0, suffixLength)}`;
}

export function selectRecoverableInboundPlan(
  plans: InboundPlanSummary[],
  expectedName: string,
): InboundPlanRecoveryMatch {
  const matches = plans.filter((plan) => (
    plan.status === 'ACTIVE'
    && plan.name === expectedName
    && Boolean(plan.inboundPlanId)
  ));
  if (matches.length === 0) return { kind: 'none' };
  if (matches.length === 1) return { kind: 'found', plan: matches[0] };
  return { kind: 'ambiguous', plans: matches };
}

export function compareInboundPlanManifest(
  expected: InboundPlanManifestItem[],
  actual: InboundPlanManifestItem[],
): { ok: true } | { ok: false; error: string } {
  const normalize = (items: InboundPlanManifestItem[]) => {
    const quantities = new Map<string, number>();
    for (const item of items) {
      const msku = item.msku?.trim();
      if (
        !msku
        || !Number.isSafeInteger(item.quantity)
        || item.quantity <= 0
      ) {
        return null;
      }
      quantities.set(msku, (quantities.get(msku) || 0) + item.quantity);
    }
    return [...quantities.entries()].sort(([a], [b]) => a.localeCompare(b));
  };

  const expectedManifest = normalize(expected);
  const actualManifest = normalize(actual);
  if (!expectedManifest || !actualManifest) {
    return { ok: false, error: 'Inbound plan contained an invalid SKU or quantity.' };
  }
  if (JSON.stringify(expectedManifest) !== JSON.stringify(actualManifest)) {
    return {
      ok: false,
      error: `Inbound plan contents do not match this batch. Expected ${
        JSON.stringify(expectedManifest)
      }, received ${JSON.stringify(actualManifest)}.`,
    };
  }
  return { ok: true };
}

/**
 * Atomically claims a draft batch before any external mutation. Exactly one
 * concurrent sender can move the row to `sending`.
 */
export function claimBatchForSend(
  db: Database.Database,
  batchId: number,
  now: string,
): boolean {
  const result = db.prepare(`
    UPDATE listing_batches
    SET status = 'sending',
        send_error = NULL,
        sent_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'draft'
  `).run(now, now, batchId);
  return result.changes === 1;
}
