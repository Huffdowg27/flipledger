import type Database from 'better-sqlite3';

export const SETTLEMENT_NET_BASIS_LABELS = {
  sales: 'settlement product sales basis',
  netRefunds: 'settlement net basis',
  grossRefunds: 'gross refund basis',
} as const;

export interface SettlementNetMetricPeriod {
  settlementId: string;
  start: string;
  end: string;
  deposit: string;
  marketplace: string | null;
  depositedCents: number;
  salesCents: number;
  netRefundsCents: number;
  grossRefundsCents: number;
  refundRatePct: number;
  transactionCount: number;
  hasTxns: boolean;
}

export interface SettlementNetMetricTotals {
  depositedCents: number;
  salesCents: number;
  netRefundsCents: number;
  grossRefundsCents: number;
  refundRatePct: number;
  transactionCount: number;
}

const datePart = (s: string | null) => (s ? String(s).slice(0, 10) : '');

function refundRatePct(netRefundsCents: number, salesCents: number): number {
  return salesCents > 0 ? (Math.abs(netRefundsCents) / salesCents) * 100 : 0;
}

export function getSettlementNetMetricPeriods(
  db: Database.Database,
  range?: { startDate?: string; endDate?: string },
): SettlementNetMetricPeriod[] {
  const filters: string[] = [];
  const params: string[] = [];

  if (range?.startDate) {
    filters.push('substr(sp.start_date, 1, 10) >= ?');
    params.push(range.startDate);
  }
  if (range?.endDate) {
    filters.push('substr(sp.start_date, 1, 10) <= ?');
    params.push(range.endDate);
  }

  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT
      sp.settlement_id,
      sp.start_date,
      sp.end_date,
      sp.deposit_date,
      sp.marketplace,
      COALESCE(SUM(t.amount_cents), 0) AS deposited_cents,
      COALESCE(SUM(CASE
        WHEN t.transaction_type = 'Order'
          AND t.amount_type = 'ItemPrice'
          AND t.amount_description = 'Principal'
        THEN t.amount_cents ELSE 0 END), 0) AS sales_cents,
      COALESCE(SUM(CASE
        WHEN t.transaction_type = 'Refund'
        THEN t.amount_cents ELSE 0 END), 0) AS net_refunds_cents,
      COALESCE(SUM(CASE
        WHEN t.transaction_type = 'Refund'
          AND t.amount_type = 'ItemPrice'
          AND t.amount_description = 'Principal'
        THEN t.amount_cents ELSE 0 END), 0) AS gross_refunds_cents,
      COUNT(t.id) AS transaction_count
    FROM settlement_periods sp
    LEFT JOIN settlement_transactions t ON t.settlement_id = sp.settlement_id
    ${where}
    GROUP BY sp.settlement_id
    ORDER BY sp.end_date DESC, sp.settlement_id DESC
  `).all(...params) as {
    settlement_id: string;
    start_date: string;
    end_date: string;
    deposit_date: string | null;
    marketplace: string | null;
    deposited_cents: number;
    sales_cents: number;
    net_refunds_cents: number;
    gross_refunds_cents: number;
    transaction_count: number;
  }[];

  return rows.map((row) => ({
    settlementId: String(row.settlement_id),
    start: datePart(row.start_date),
    end: datePart(row.end_date),
    deposit: datePart(row.deposit_date),
    marketplace: row.marketplace || null,
    depositedCents: row.deposited_cents,
    salesCents: row.sales_cents,
    netRefundsCents: row.net_refunds_cents,
    grossRefundsCents: row.gross_refunds_cents,
    refundRatePct: refundRatePct(row.net_refunds_cents, row.sales_cents),
    transactionCount: row.transaction_count,
    hasTxns: row.transaction_count > 0,
  }));
}

export function summarizeSettlementNetMetrics(
  periods: SettlementNetMetricPeriod[],
): SettlementNetMetricTotals {
  const totals = periods.reduce(
    (acc, period) => {
      acc.depositedCents += period.depositedCents;
      acc.salesCents += period.salesCents;
      acc.netRefundsCents += period.netRefundsCents;
      acc.grossRefundsCents += period.grossRefundsCents;
      acc.transactionCount += period.transactionCount;
      return acc;
    },
    {
      depositedCents: 0,
      salesCents: 0,
      netRefundsCents: 0,
      grossRefundsCents: 0,
      refundRatePct: 0,
      transactionCount: 0,
    },
  );

  totals.refundRatePct = refundRatePct(totals.netRefundsCents, totals.salesCents);
  return totals;
}
