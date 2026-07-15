'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import PageHeader from '@/components/ui/PageHeader';
import StatCard from '@/components/ui/StatCard';
import { useFilters } from '@/lib/useFilters';
import { formatCurrency } from '@/lib/formatters';

// Reproduces Jamie's Profit_First_Amazon.xlsx STEP 1-4 (Payout Input tab).
// Auto numbers come from the P&L engine; Net Proceeds + allocation %s + monthly
// OpEx are manual inputs persisted to localStorage (personal calculator).
// COGS here is FlipLedger's event-based adjusted COGS (sellable returns already
// reversed) — more accurate than a blended return-rate estimate.

const LS_KEY = 'flipledger_profit_first_v1';

type Buckets = { profit: number; ownerPay: number; tax: number; opex: number };
type Cfg = {
  netProceeds: number;       // dollars, manual (Amazon settlement deposit)
  grossCogs: number;         // dollars, manual (from IL, pre-return-adjustment)
  veeqo: number;             // dollars, manual override (0 = use synced)
  pct: Buckets;              // allocation percentages
  monthlyOpex: number;       // dollars, actual monthly OpEx
  payoutsPerMonth: number;   // usually 2
};
const DEFAULT_CFG: Cfg = {
  netProceeds: 0, grossCogs: 0, veeqo: 0,
  pct: { profit: 5, ownerPay: 35, tax: 25, opex: 35 },
  monthlyOpex: 0, payoutsPerMonth: 2,
};

function dollars(n: number) { return formatCurrency(Math.round(n * 100)); }

// Jamie's COGS adjustment: back out returned-unit cost, keeping a ~3% buffer for
// returnless refunds. factor = 1.03 - returnRate/100 (11% -> .92, 10% -> .93).
// "Under 12% start adjusting up" -> >=12% sits at the .91 floor; never above 1.0.
function cogsFactor(returnRatePct: number): number {
  const r = Math.min(Math.max(returnRatePct, 0), 12);
  return Math.min(1, 1.03 - r / 100);
}

export default function ProfitFirstPage() {
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam, dateBasis, setDateBasis, dateBasisParam } = useFilters();
  const [pl, setPl] = useState<any | null>(null);
  const [cfg, setCfg] = useState<Cfg>(DEFAULT_CFG);
  const [loading, setLoading] = useState(true);
  type Period = {
    settlementId: string;
    start: string;
    end: string;
    deposit: string;
    depositedCents: number;
    salesCents: number;
    netRefundsCents: number;
    grossRefundsCents: number;
    refundRatePct: number;
    hasTxns: boolean;
  };
  const [periods, setPeriods] = useState<Period[]>([]);
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  // settlement-accurate totals for the selected statement range (penny-exact to Amazon)
  const [settleTotals, setSettleTotals] = useState<{ deposited: number; netRefunds: number; grossRefunds: number; sales: number } | null>(null);

  // load settlement statements for the picker
  useEffect(() => {
    fetch('/api/data/settlement-net-metrics').then(r => r.json()).then(j => setPeriods(j.periods || [])).catch(() => {});
  }, []);
  // when both ends chosen, scope the window to settlement boundaries AND sum the
  // settlement-accurate Deposited/Refunds/Sales across the inclusive range.
  function applyStatements(fId: string, tId: string) {
    const f = periods.find(p => p.settlementId === fId);
    const t = periods.find(p => p.settlementId === tId);
    if (!f || !t) return;
    const start = f.start <= t.start ? f.start : t.start;
    const end = f.end >= t.end ? f.end : t.end;
    setDateRange({ preset: 'custom', startDate: start, endDate: end });
    // Inclusive set: all statements whose window falls within [start, end].
    // Exclude anomalous long-span settlements (>3 days) that overlap the dailies.
    const inRange = periods.filter(p => p.start >= start && p.end <= end && p.hasTxns
      && (new Date(p.end).getTime() - new Date(p.start).getTime()) / 86400000 <= 3);
    const deposited = inRange.reduce((s, p) => s + p.depositedCents, 0) / 100;
    const netRefunds = inRange.reduce((s, p) => s + p.netRefundsCents, 0) / 100;
    const grossRefunds = inRange.reduce((s, p) => s + p.grossRefundsCents, 0) / 100;
    const sales = inRange.reduce((s, p) => s + p.salesCents, 0) / 100;
    setSettleTotals({ deposited, netRefunds, grossRefunds, sales });
    // Auto-fill Net Proceeds (deposit) — replaces the manual blue cell.
    save({ ...cfg, netProceeds: Math.round(deposited * 100) / 100 });
  }

  // load saved config
  useEffect(() => {
    try { const raw = localStorage.getItem(LS_KEY); if (raw) setCfg({ ...DEFAULT_CFG, ...JSON.parse(raw) }); } catch {}
  }, []);
  const save = useCallback((next: Cfg) => { setCfg(next); try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch {} }, []);

  // pull P&L numbers for the selected settlement period
  useEffect(() => {
    setLoading(true);
    fetch(`/api/data/profitloss?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}${dateBasisParam}`)
      .then(r => r.json()).then(j => { setPl(j); setLoading(false); }).catch(() => setLoading(false));
  }, [dateRange, marketplace, dateBasis]);

  const m = useMemo(() => {
    // Prefer settlement-accurate totals (penny-exact to Amazon) when statements
    // are picked; else fall back to the P&L engine for ad-hoc date ranges.
    const sales = settleTotals ? settleTotals.sales : (pl?.income?.sales || 0) / 100;
    const refunds = settleTotals ? Math.abs(settleTotals.netRefunds) : (pl?.refunds?.total || 0) / 100;
    const flCogs = (pl?.expenses?.cogs || 0) / 100;           // FL event-based (reference)
    const syncedVeeqo = (pl?.expenses?.shippingCosts || 0) / 100;
    const veeqo = cfg.veeqo > 0 ? cfg.veeqo : syncedVeeqo;
    const returnRate = sales > 0 ? (refunds / sales) * 100 : 0;
    // Gross COGS auto from FlipLedger (FIFO, pre-return) — replaces the IL input.
    // Manual override only if cfg.grossCogs > 0.
    const grossCogs = cfg.grossCogs > 0 ? cfg.grossCogs : (pl?.expenses?.cogsGross || 0) / 100;
    // Adjusted COGS = Jamie's method: Gross COGS × return-rate factor.
    const factor = cogsFactor(returnRate);
    const adjCogs = grossCogs * factor;
    const realRevenue = cfg.netProceeds - adjCogs;
    const realRevenueVeeqo = realRevenue - veeqo;
    const base = realRevenue;                                  // allocations run on Real Revenue
    const alloc = {
      profit: base * cfg.pct.profit / 100,
      ownerPay: base * cfg.pct.ownerPay / 100,
      tax: base * cfg.pct.tax / 100,
      opex: base * cfg.pct.opex / 100,
    };
    const pctTotal = cfg.pct.profit + cfg.pct.ownerPay + cfg.pct.tax + cfg.pct.opex;
    const opexPerPayout = cfg.payoutsPerMonth > 0 ? cfg.monthlyOpex / cfg.payoutsPerMonth : 0;
    const opexPctReal = base > 0 ? (opexPerPayout / base) * 100 : 0;
    const opexTarget35 = base * 0.35;
    const opexGap = opexTarget35 - opexPerPayout;
    return { sales, refunds, flCogs, grossCogs, factor, adjCogs, veeqo, returnRate, realRevenue, realRevenueVeeqo, alloc, pctTotal, opexPerPayout, opexPctReal, opexTarget35, opexGap };
  }, [pl, cfg, settleTotals]);

  return (
    <div>
      <PageHeader
        title="Profit First"
        subtitle="Analyze > Profit First"
        dateRange={dateRange} onDateRangeChange={setDateRange}
        marketplace={marketplace} onMarketplaceChange={setMarketplace}
        dateBasis={dateBasis} onDateBasisChange={setDateBasis}
      />

      {/* Settlement statement picker — scope to real Amazon settlement boundaries */}
      {periods.length > 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg p-4 mb-6 flex flex-wrap items-center gap-3">
          <span className="text-sm font-semibold text-text-secondary">By settlement statement:</span>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-text-tertiary">From</span>
            <select value={fromId} onChange={e => { setFromId(e.target.value); applyStatements(e.target.value, toId || e.target.value); }}
              className="bg-bg-elevated border border-border-default rounded px-2 py-1 text-text-primary text-sm">
              <option value="">— statement —</option>
              {periods.map(p => <option key={p.settlementId} value={p.settlementId}>{p.start} → {p.end} (dep {p.deposit})</option>)}
            </select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-text-tertiary">To</span>
            <select value={toId} onChange={e => { setToId(e.target.value); applyStatements(fromId || e.target.value, e.target.value); }}
              className="bg-bg-elevated border border-border-default rounded px-2 py-1 text-text-primary text-sm">
              <option value="">— statement —</option>
              {periods.map(p => <option key={p.settlementId} value={p.settlementId}>{p.start} → {p.end} (dep {p.deposit})</option>)}
            </select>
          </label>
          <span className="text-[11px] text-text-tertiary">Snaps the window to Amazon's settlement boundaries (avoids the +1-day mismatch).</span>
        </div>
      )}

      {/* KEY numbers */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Real Revenue" value={Math.round(m.realRevenue * 100)} format="currency" accentColor={m.realRevenue >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Adjusted COGS" value={Math.round(m.adjCogs * 100)} format="currency" accentColor="negative" />{/* Gross×factor */}
        <StatCard label="Return Rate ($)" value={m.returnRate} format="percent" accentColor="default" />
        <StatCard label="Net Proceeds (entered)" value={Math.round(cfg.netProceeds * 100)} format="currency" accentColor="default" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* STEP 1-2: settlement + adjusted COGS */}
        <Panel title="Step 1-2 · Settlement & Adjusted COGS">
          <Row label="Settlement period">{dateRange.startDate} → {dateRange.endDate}</Row>
          <InputRow label="Amazon Net Proceeds (deposit)" hint="From Seller Central settlement screen"
            value={cfg.netProceeds} onChange={v => save({ ...cfg, netProceeds: v })} />
          <Row label={settleTotals ? 'Sales (settlement product sales basis)' : 'Total Sales'} auto>{dollars(m.sales)}</Row>
          <Row label={settleTotals ? 'Net Refunds (settlement net basis)' : 'Refunded Sales'} auto>{dollars(m.refunds)}</Row>
          {settleTotals && <Row label="Gross Refunds (gross refund basis)" auto>{dollars(Math.abs(settleTotals.grossRefunds))}</Row>}
          <Row label="Return Rate (Refunds ÷ Sales)" auto>{m.returnRate.toFixed(1)}%</Row>
          <Row label="Gross COGS (FlipLedger FIFO, pre-return)" auto>{dollars(m.grossCogs)}</Row>
          <InputRow label="Gross COGS override" hint="0 = use FlipLedger's"
            value={cfg.grossCogs} onChange={v => save({ ...cfg, grossCogs: v })} />
          <Row label={`COGS factor (×, return-rate based)`} auto>×{m.factor.toFixed(2)}</Row>
          <Row label="Adjusted COGS (Gross × factor)" auto bold>{dollars(m.adjCogs)}</Row>
          <InputRow label="Veeqo Shipping override" hint={`0 = use synced (${dollars((pl?.expenses?.shippingCosts || 0) / 100)})`}
            value={cfg.veeqo} onChange={v => save({ ...cfg, veeqo: v })} />
          <Row label="Real Revenue (Net Proceeds − Adj COGS)" auto bold>{dollars(m.realRevenue)}</Row>
          <Row label="Real Revenue w/ Veeqo" auto>{dollars(m.realRevenueVeeqo)}</Row>
        </Panel>

        {/* STEP 3: allocations */}
        <Panel title="Step 3 · Profit First Allocations">
          <p className="text-xs text-text-tertiary mb-3">Allocated on Real Revenue. Edit % to match your buckets.</p>
          <PctRow label="Profit" pct={cfg.pct.profit} amount={m.alloc.profit} onPct={v => save({ ...cfg, pct: { ...cfg.pct, profit: v } })} />
          <PctRow label="Owner's Pay" pct={cfg.pct.ownerPay} amount={m.alloc.ownerPay} onPct={v => save({ ...cfg, pct: { ...cfg.pct, ownerPay: v } })} />
          <PctRow label="Tax" pct={cfg.pct.tax} amount={m.alloc.tax} onPct={v => save({ ...cfg, pct: { ...cfg.pct, tax: v } })} />
          <PctRow label="OpEx" pct={cfg.pct.opex} amount={m.alloc.opex} onPct={v => save({ ...cfg, pct: { ...cfg.pct, opex: v } })} />
          <div className={`flex justify-between border-t border-border-subtle pt-2 mt-1 text-sm font-semibold ${m.pctTotal === 100 ? 'text-text-primary' : 'text-warning'}`}>
            <span>Total {m.pctTotal !== 100 ? `(should be 100%)` : ''}</span><span>{m.pctTotal}%</span>
          </div>
        </Panel>

        {/* STEP 4: OpEx reality check */}
        <Panel title="Step 4 · OpEx Reality Check">
          <InputRow label="Actual Monthly OpEx" hint="From your OpEx tracker"
            value={cfg.monthlyOpex} onChange={v => save({ ...cfg, monthlyOpex: v })} />
          <Row label={`OpEx per Payout (÷${cfg.payoutsPerMonth})`} auto>{dollars(m.opexPerPayout)}</Row>
          <Row label="OpEx as % of Real Revenue" auto>
            <span className={m.opexPctReal <= 35 ? 'text-positive' : 'text-negative'}>{m.opexPctReal.toFixed(1)}%</span>
          </Row>
          <Row label="OpEx Target (35% of Real Rev)" auto>{dollars(m.opexTarget35)}</Row>
          <Row label="OpEx Gap (+room / −over)" auto bold>
            <span className={m.opexGap >= 0 ? 'text-positive' : 'text-negative'}>{dollars(m.opexGap)}</span>
          </Row>
        </Panel>
      </div>

      <p className="text-[11px] text-text-tertiary mt-6">
        v1: Net Proceeds, allocation %s, and monthly OpEx are saved in this browser. Adjusted COGS is event-based
        (sellable returns already reversed) — more accurate than a blended return-rate estimate. History tab,
        deposit auto-pull, and per-channel breakdown are planned next.
      </p>
    </div>
  );
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-border-subtle text-sm font-semibold text-text-primary">{title}</div>
      <div className="p-4 space-y-2">{children}</div>
    </div>
  );
}
function Row({ label, children, auto, bold }: { label: string; children: React.ReactNode; auto?: boolean; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between text-sm ${bold ? 'font-semibold' : ''}`}>
      <span className="text-text-secondary">{label}{auto && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-text-tertiary">auto</span>}</span>
      <span className="font-mono text-text-primary">{children}</span>
    </div>
  );
}
function InputRow({ label, hint, value, onChange }: { label: string; hint?: string; value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm gap-3">
      <span className="text-text-secondary">{label}{hint && <span className="block text-[10px] text-text-tertiary">{hint}</span>}</span>
      <span className="flex items-center gap-1">
        <span className="text-text-tertiary">$</span>
        <input type="number" step="0.01" value={value || ''} onChange={e => onChange(parseFloat(e.target.value) || 0)}
          className="w-28 bg-bg-elevated border border-border-default rounded px-2 py-1 text-right font-mono text-text-primary focus:border-accent outline-none" />
      </span>
    </div>
  );
}
function PctRow({ label, pct, amount, onPct }: { label: string; pct: number; amount: number; onPct: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-text-secondary">{label}</span>
      <span className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <input type="number" step="1" value={pct || ''} onChange={e => onPct(parseFloat(e.target.value) || 0)}
            className="w-16 bg-bg-elevated border border-border-default rounded px-2 py-1 text-right font-mono text-text-primary focus:border-accent outline-none" />
          <span className="text-text-tertiary">%</span>
        </span>
        <span className="font-mono text-text-primary w-24 text-right">{dollars(amount)}</span>
      </span>
    </div>
  );
}
