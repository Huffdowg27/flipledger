'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { formatCurrency } from '@/lib/formatters';
import { calculateProfit, calculateROI, calculateMargin } from '@/lib/calculations';
import { ArrowLeft, Archive } from 'lucide-react';

interface BatchRow {
  id: number;
  name: string;
  status: string;
  channel: string;
  marketplace: string;
  inboundPlanId: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  totalUnits: number;
  skuCount: number;
  expectedRevenue: number;
  totalCost: number;
  estimatedFees: number;
  estimatedShip: number;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function Metric({ label, value, valueClass = 'text-text-primary' }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-text-tertiary">{label}</dt>
      <dd className={`font-mono ${valueClass}`}>{value}</dd>
    </div>
  );
}

export default function BatchHistoryPage() {
  const [batches, setBatches] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchBatches = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/list/batches');
      const data = await res.json();
      setBatches(data.batches || []);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchBatches(); }, [fetchBatches]);

  // History = closed batches only, most-recently-closed first.
  const closed = batches
    .filter((b) => b.status === 'closed')
    .sort((a, b) => (b.closedAt || b.updatedAt).localeCompare(a.closedAt || a.updatedAt));

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <Link href="/list" className="inline-flex items-center gap-1.5 text-xs text-text-tertiary hover:text-text-secondary mb-1">
            <ArrowLeft size={13} />
            Back to Batches
          </Link>
          <h1 className="text-xl font-semibold tracking-tight">Batch History</h1>
          <p className="text-sm text-text-tertiary mt-0.5">Closed batches · a permanent record of what was pushed, for auditing</p>
        </div>
      </div>

      {loading ? (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-8 text-center text-text-tertiary">
          Loading history…
        </div>
      ) : closed.length === 0 ? (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-12 text-center">
          <Archive size={48} className="mx-auto text-text-tertiary mb-3" />
          <h3 className="text-base font-medium text-text-primary mb-1">No closed batches yet</h3>
          <p className="text-sm text-text-tertiary">
            When you push all eligible items in a batch, it closes and lands here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {closed.map((b) => {
            // Estimated net for the batch — Revenue − Cost − Fees − Shipping,
            // through the canonical profit math (incl. shipping, which the old
            // card silently dropped). ROI is over cost, margin over revenue.
            const netProfit = calculateProfit(b.expectedRevenue, b.totalCost, b.estimatedFees, b.estimatedShip);
            const netROI = calculateROI(netProfit, b.totalCost);
            const netMargin = calculateMargin(netProfit, b.expectedRevenue);
            const profitClass = netProfit >= 0 ? 'text-positive' : 'text-negative';
            return (
              <Link
                key={b.id}
                href={`/list/${b.id}`}
                className="block bg-bg-surface border border-border-subtle rounded-lg p-4 hover:border-border-default hover:bg-bg-hover transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-text-primary truncate">{b.name}</div>
                    <div className="text-[11px] text-text-tertiary mt-0.5">
                      {b.channel} · {b.skuCount} SKUs · closed {fmtDate(b.closedAt || b.updatedAt)}
                    </div>
                  </div>
                  <span className="inline-flex items-center px-2 py-0.5 rounded border text-[10px] font-semibold uppercase tracking-wider bg-text-tertiary/10 text-text-tertiary border-text-tertiary/20 shrink-0">
                    Closed
                  </span>
                </div>

                <dl className="space-y-1.5 text-xs">
                  <Metric label="Quantity" value={`${b.totalUnits} units`} />
                  <Metric label="Revenue" value={formatCurrency(b.expectedRevenue)} />
                  <Metric label="Cost" value={formatCurrency(b.totalCost)} />
                  <Metric label="Shipping / Fees" value={`${formatCurrency(b.estimatedShip)} / ${formatCurrency(b.estimatedFees)}`} />
                  <div className="border-t border-border-subtle/60 my-1.5" />
                  <Metric label="Net Profit" value={formatCurrency(netProfit)} valueClass={`font-semibold ${profitClass}`} />
                  <Metric label="Net ROI" value={`${netROI.toFixed(1)}%`} valueClass={profitClass} />
                  <Metric label="Net Margin" value={`${netMargin.toFixed(1)}%`} valueClass={profitClass} />
                </dl>
                <p className="text-[10px] text-text-tertiary mt-2">Estimated at list price</p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
