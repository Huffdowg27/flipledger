'use client';

import { useEffect, useState, useCallback } from 'react';
import StatCard from '@/components/ui/StatCard';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import { formatCurrency, formatCurrencyParens, formatNumber } from '@/lib/formatters';
import { ChevronDown, ChevronRight, Package } from 'lucide-react';

interface SaleItem {
  order_id: string;
  marketplace: string;
  fulfillment_channel: string;
  product_name: string;
  asin: string;
  sku: string;
  quantity: number;
  revenue: number;
  cogs: number;
  fees: number;
  shippingCost: number;
  net_profit: number;
  posted_date: string;
  purchase_date: string;
}

interface PLData {
  income: { sales: number; shippingCredits: number; otherIncome: number; total: number };
  expenses: {
    cogs: number;
    feeHierarchy: Record<string, { total: number; children: { name: string; amount: number }[] }>;
    shippingCosts: number;
    otherExpenses: number;
    otherExpensesByCategory: { category: string; total: number }[];
    totalFees: number;
    total: number;
  };
  refunds: { total: number; clawback: number; net: number };
  reimbursements: number;
  salesTax: { collected: number; facilitator: number };
  netProfit: number;
  margin: number;
  salesDetail?: SaleItem[];
  refundDetail?: RefundItem[];
}

interface RefundItem {
  order_id: string;
  marketplace: string;
  product_name: string;
  asin: string;
  sku: string;
  quantity: number;
  refund_amount: number;
  fee_clawback: number;
  reason: string;
  refund_date: string;
}

export default function ProfitLossPage() {
  const [data, setData] = useState<PLData | null>(null);
  const [loading, setLoading] = useState(true);
  const { dateRange, setDateRange, marketplace, setMarketplace, marketplaceParam, dateBasis, setDateBasis, dateBasisParam } = useFilters();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/profitloss?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}${dateBasisParam}`);
    setData(await res.json());
    setLoading(false);
  }, [dateRange, marketplace, dateBasis]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function toggleSection(key: string) {
    setExpandedSections(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  function expandAll() {
    if (!data) return;
    const allKeys = new Set([
      ...Object.keys(data.expenses.feeHierarchy),
      'otherExpenses',
    ]);
    setExpandedSections(allKeys);
  }

  function collapseAll() {
    setExpandedSections(new Set());
  }

  if (loading || !data) return <PLSkeleton />;

  return (
    <div>
      <PageHeader
        title="Profit & Loss"
        subtitle="Analyze > Profit & Loss"
        dateRange={dateRange}
        onDateRangeChange={setDateRange}
        marketplace={marketplace}
        onMarketplaceChange={setMarketplace}
        dateBasis={dateBasis}
        onDateBasisChange={setDateBasis}
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Revenue" value={data.income.total} format="currency" accentColor="default" />
        <StatCard label="Total Expenses" value={data.expenses.total} format="currency" accentColor="negative" />
        <StatCard label="Net Profit" value={data.netProfit} format="currency" accentColor={data.netProfit >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Margin" value={data.margin} format="percent" accentColor={data.margin >= 0 ? 'positive' : 'negative'} />
      </div>

      {/* P&L Table */}
      <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
        {/* Controls */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-border-subtle">
          <button onClick={expandAll} className="text-xs text-text-tertiary hover:text-text-secondary transition-colors">Expand All</button>
          <span className="text-text-tertiary">|</span>
          <button onClick={collapseAll} className="text-xs text-text-tertiary hover:text-text-secondary transition-colors">Collapse All</button>
        </div>

        <table className="w-full">
          <thead>
            <tr className="bg-bg-elevated">
              <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle">Category</th>
              <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-40">Amount</th>
            </tr>
          </thead>
          <tbody>
            {/* ─── INCOME SECTION ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-2 text-xs font-semibold tracking-widest uppercase text-accent">Income</td>
            </tr>
            <PLRow label="Sales" amount={data.income.sales} />
            <PLRow label="MFN Shipping Credits" amount={data.income.shippingCredits} />
            <PLRow label="Other Income" amount={data.income.otherIncome} />
            <PLRow label="Total Income" amount={data.income.total} bold />

            {/* ─── EXPENSES SECTION ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-2 text-xs font-semibold tracking-widest uppercase text-negative">Expenses</td>
            </tr>
            <PLRow label="Cost of Goods Sold" amount={-data.expenses.cogs} />

            {/* Fee categories — expandable */}
            {Object.entries(data.expenses.feeHierarchy).map(([category, { total, children }]) => (
              <ExpandableSection
                key={category}
                label={category}
                total={-total}
                children={children.map(c => ({ label: c.name, amount: -c.amount }))}
                expanded={expandedSections.has(category)}
                onToggle={() => toggleSection(category)}
              />
            ))}

            <PLRow label="MFN Shipping Costs" amount={-data.expenses.shippingCosts} />

            <ExpandableSection
              label="Other Expenses"
              total={-data.expenses.otherExpenses}
              children={data.expenses.otherExpensesByCategory.map(c => ({ label: c.category, amount: -c.total }))}
              expanded={expandedSections.has('otherExpenses')}
              onToggle={() => toggleSection('otherExpenses')}
            />

            <PLRow label="Total Expenses" amount={-data.expenses.total} bold negative />

            {/* ─── ADJUSTMENTS ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-2 text-xs font-semibold tracking-widest uppercase text-text-tertiary">Adjustments</td>
            </tr>
            <PLRow label="Refunds Issued" amount={-data.refunds.total} negative />
            <PLRow label="Fee Clawbacks (on refunds)" amount={data.refunds.clawback} />
            <PLRow label="Reimbursements" amount={data.reimbursements} />

            {/* ─── SALES TAX ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-2 text-xs font-semibold tracking-widest uppercase text-text-tertiary">Sales Tax</td>
            </tr>
            <PLRow label="Tax Collected" amount={data.salesTax.collected} />
            <PLRow label="Marketplace Facilitator Tax" amount={-data.salesTax.facilitator} />

            {/* ─── NET PROFIT ─── */}
            <tr className="border-t-2 border-border-strong bg-bg-elevated">
              <td className="px-4 py-3 text-md font-bold text-text-primary">Net Profit</td>
              <td className={`px-4 py-3 text-right text-md font-bold font-mono ${data.netProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
                {formatCurrency(data.netProfit)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Sales Detail */}
      {data.salesDetail && data.salesDetail.length > 0 && (
        <div className="mt-6 bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
            <div className="flex items-center gap-2">
              <Package size={14} className="text-accent" />
              <span className="text-sm font-semibold text-text-primary">Sales Detail</span>
              <span className="text-xs text-text-tertiary">({data.salesDetail.length} items)</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-elevated">
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle">Product</th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-20">Mkt</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-16">Qty</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Revenue</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">COGS</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Fees</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Net Profit</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-20">Margin</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Settled</th>
                </tr>
              </thead>
              <tbody>
                {data.salesDetail.map((item, i) => {
                  const margin = item.revenue > 0 ? (item.net_profit / item.revenue) * 100 : 0;
                  const fees = -item.fees; // fees are stored as negative, display as positive cost
                  const settledTime = new Date(item.posted_date);
                  const timeStr = settledTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                  const dateStr = settledTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                  const mktLabel = item.marketplace === 'amazon' ? 'AMZ' : item.marketplace === 'walmart' ? 'WMT' : item.marketplace === 'ebay' ? 'EBAY' : item.marketplace === 'paypal' ? 'PP' : (item.marketplace || '').toUpperCase();
                  const mktColor = item.marketplace === 'amazon' ? 'bg-orange-500/10 text-orange-400' : item.marketplace === 'walmart' ? 'bg-blue-500/10 text-blue-400' : item.marketplace === 'ebay' ? 'bg-green-500/10 text-green-400' : item.marketplace === 'paypal' ? 'bg-cyan-500/10 text-cyan-400' : 'bg-text-tertiary/10 text-text-tertiary';
                  return (
                    <tr key={`${item.order_id}-${item.sku}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[300px]" title={item.product_name}>{item.product_name}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${mktColor}`}>
                          {mktLabel}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">{item.quantity}</td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-primary">{formatCurrency(item.revenue)}</td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-negative">{item.cogs > 0 ? formatCurrency(-item.cogs) : '-'}</td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-negative">{fees > 0 ? formatCurrency(-fees) : '-'}</td>
                      <td className={`px-4 py-2 text-right text-sm font-mono font-medium ${item.net_profit >= 0 ? 'text-positive' : 'text-negative'}`}>
                        {formatCurrency(item.net_profit)}
                      </td>
                      <td className={`px-4 py-2 text-right text-sm font-mono ${margin >= 20 ? 'text-positive' : margin >= 0 ? 'text-text-secondary' : 'text-negative'}`}>
                        {margin.toFixed(1)}%
                      </td>
                      <td className="px-4 py-2 text-right text-xs text-text-tertiary">
                        <div>{dateStr}</div>
                        <div>{timeStr}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Refund Detail */}
      {data?.refundDetail && data.refundDetail.length > 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-border-subtle">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-negative">Returns</span>
              <span className="text-xs text-text-tertiary">({data.refundDetail.length} items)</span>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-bg-elevated">
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle">Product</th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-20">Mkt</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-16">Qty</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Refund</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-24">Fee Clawback</th>
                  <th className="px-4 py-2.5 text-left text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-40">Reason</th>
                  <th className="px-4 py-2.5 text-right text-[11px] font-medium tracking-widest uppercase text-text-tertiary border-b border-border-subtle w-28">Date</th>
                </tr>
              </thead>
              <tbody>
                {data.refundDetail.map((item, i) => {
                  const refundTime = new Date(item.refund_date);
                  const timeStr = refundTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
                  const dateStr = refundTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                  const mktLabel = item.marketplace === 'amazon' ? 'AMZ' : item.marketplace === 'walmart' ? 'WMT' : item.marketplace === 'ebay' ? 'EBAY' : item.marketplace === 'paypal' ? 'PP' : (item.marketplace || '').toUpperCase();
                  const mktColor = item.marketplace === 'amazon' ? 'bg-orange-500/10 text-orange-400' : item.marketplace === 'walmart' ? 'bg-blue-500/10 text-blue-400' : item.marketplace === 'ebay' ? 'bg-green-500/10 text-green-400' : item.marketplace === 'paypal' ? 'bg-cyan-500/10 text-cyan-400' : 'bg-text-tertiary/10 text-text-tertiary';
                  return (
                    <tr key={`refund-${item.order_id}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[300px]" title={item.product_name}>{item.product_name}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku}</div>
                      </td>
                      <td className="px-4 py-2">
                        <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wider ${mktColor}`}>
                          {mktLabel}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-text-secondary">{item.quantity}</td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-negative">{formatCurrency(-item.refund_amount)}</td>
                      <td className="px-4 py-2 text-right text-sm font-mono text-positive">{item.fee_clawback > 0 ? formatCurrency(item.fee_clawback) : '-'}</td>
                      <td className="px-4 py-2 text-left text-sm text-text-secondary">{item.reason || '-'}</td>
                      <td className="px-4 py-2 text-right text-xs text-text-tertiary">
                        <div>{dateStr}</div>
                        <div>{timeStr}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function PLRow({ label, amount, bold, negative, indent }: {
  label: string;
  amount: number;
  bold?: boolean;
  negative?: boolean;
  indent?: boolean;
}) {
  const isNeg = amount < 0;
  return (
    <tr className="border-b border-border-subtle hover:bg-bg-hover transition-colors">
      <td className={`px-4 py-2 text-sm ${bold ? 'font-semibold text-text-primary' : 'text-text-secondary'} ${indent ? 'pl-10' : ''}`}>
        {label}
      </td>
      <td className={`px-4 py-2 text-right text-sm font-mono ${
        bold ? 'font-semibold' : ''
      } ${isNeg ? 'text-negative' : 'text-text-primary'}`}>
        {isNeg ? formatCurrencyParens(amount) : formatCurrency(amount)}
      </td>
    </tr>
  );
}

function ExpandableSection({ label, total, children, expanded, onToggle }: {
  label: string;
  total: number;
  children: { label: string; amount: number }[];
  expanded: boolean;
  onToggle: () => void;
}) {
  const isNeg = total < 0;
  return (
    <>
      <tr className="border-b border-border-subtle hover:bg-bg-hover transition-colors cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-2 text-sm font-medium text-text-primary">
          <div className="flex items-center gap-1.5">
            {expanded ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronRight size={14} className="text-text-tertiary" />}
            {label}
          </div>
        </td>
        <td className={`px-4 py-2 text-right text-sm font-mono font-medium ${isNeg ? 'text-negative' : 'text-text-primary'}`}>
          {isNeg ? formatCurrencyParens(total) : formatCurrency(total)}
        </td>
      </tr>
      {expanded && children.map((child, i) => (
        <PLRow key={i} label={child.label} amount={child.amount} indent />
      ))}
    </>
  );
}

function PLSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div><div className="skeleton h-6 w-32 mb-2" /><div className="skeleton h-4 w-48" /></div>
        <div className="skeleton h-9 w-40" />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-bg-surface border border-border-subtle rounded-lg p-5">
            <div className="skeleton h-3 w-20 mb-3" /><div className="skeleton h-8 w-28" />
          </div>
        ))}
      </div>
      <div className="bg-bg-surface border border-border-subtle rounded-lg p-4">
        {Array.from({ length: 12 }).map((_, i) => <div key={i} className="skeleton h-8 w-full mb-1" />)}
      </div>
    </div>
  );
}
