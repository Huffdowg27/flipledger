export interface IncomingBulkReconciliationRow {
  id: number;
  sku: string | null;
  quantity: number;
  quantityReceived: number;
  orderedAt: string | null;
  skuInSellerCentral?: boolean | null;
  liveSkusForAsin?: Array<{ sku: string; status: string | null }>;
}

export interface IncomingBulkReconciliationCandidate {
  inventoryLedgerId: number;
  sku: string | null;
  availableToReconcile: number;
  receivedAt: string | null;
  datePurchased: string | null;
}

export type IncomingBulkReconciliationReason =
  | 'no_candidates'
  | 'multiple_candidates'
  | 'sku_mismatch'
  | 'sku_not_exact'
  | 'missing_order_date'
  | 'missing_lot_date'
  | 'lot_before_order'
  | 'insufficient_available';

export type IncomingBulkReconciliationClassification =
  | {
      highConfidence: true;
      inventoryLedgerId: number;
      quantity: number;
      lotDate: string;
    }
  | {
      highConfidence: false;
      reason: IncomingBulkReconciliationReason;
    };

function dateKey(value: string | null): string | null {
  if (!value) return null;
  const direct = /^\d{4}-\d{2}-\d{2}/.exec(value);
  if (direct) return direct[0];
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

export function classifyIncomingBulkReconciliation(
  row: IncomingBulkReconciliationRow,
  candidates: IncomingBulkReconciliationCandidate[],
): IncomingBulkReconciliationClassification {
  if (candidates.length === 0) return { highConfidence: false, reason: 'no_candidates' };
  if (candidates.length > 1) return { highConfidence: false, reason: 'multiple_candidates' };
  if (row.skuInSellerCentral === false && (row.liveSkusForAsin?.length ?? 0) > 0) {
    return { highConfidence: false, reason: 'sku_mismatch' };
  }

  const [candidate] = candidates;
  if (!row.sku || !candidate.sku || row.sku !== candidate.sku) {
    return { highConfidence: false, reason: 'sku_not_exact' };
  }

  const orderedDate = dateKey(row.orderedAt);
  if (!orderedDate) return { highConfidence: false, reason: 'missing_order_date' };

  const lotDateValue = candidate.receivedAt || candidate.datePurchased;
  const lotDate = dateKey(lotDateValue);
  if (!lotDate || !lotDateValue) return { highConfidence: false, reason: 'missing_lot_date' };
  if (lotDate < orderedDate) return { highConfidence: false, reason: 'lot_before_order' };

  const remaining = Math.max(0, Number(row.quantity) - Number(row.quantityReceived));
  if (candidate.availableToReconcile < remaining) {
    return { highConfidence: false, reason: 'insufficient_available' };
  }

  return {
    highConfidence: true,
    inventoryLedgerId: candidate.inventoryLedgerId,
    quantity: remaining,
    lotDate: lotDateValue,
  };
}
