'use client';

import { useEffect, useState, useCallback } from 'react';
import StatCard from '@/components/ui/StatCard';
import StatusBadge, { type StatusBadgeTone } from '@/components/ui/StatusBadge';
import PageHeader from '@/components/ui/PageHeader';
import { type DateRange } from '@/components/ui/DateRangePicker';
import { useFilters } from '@/lib/useFilters';
import { formatCurrency, formatCurrencyParens, formatNumber } from '@/lib/formatters';
import { ChevronDown, ChevronRight, ChevronUp, Package } from 'lucide-react';

function marketplaceTone(m: string): StatusBadgeTone {
  if (m === 'amazon')  return 'amazon';
  if (m === 'walmart') return 'walmart';
  if (m === 'ebay')    return 'ebay';
  if (m === 'paypal')  return 'paypal';
  return 'neutral';
}

function marketplaceLabel(m: string): string {
  if (m === 'amazon')  return 'AMZ';
  if (m === 'walmart') return 'WMT';
  if (m === 'ebay')    return 'EBAY';
  if (m === 'paypal')  return 'PP';
  return (m || '').toUpperCase();
}

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
  income: { sales: number; shippingCredits: number; fbaShippingCredits: number; promoRebates: number; restockingFees: number; otherIncome: number; total: number };
  expenses: {
    cogs: number;
    feeHierarchy: Record<string, { total: number; children: { name: string; amount: number }[] }>;
    shippingCosts: number;
    otherExpenses: number;
    otherExpensesByCategory: { category: string; total: number }[];
    inventoryWriteoff?: number;
    totalFees: number;
    total: number;
  };
  refunds: { total: number; clawback: number; net: number };
  reimbursements: number;
  salesTax: { collected: number; facilitator: number };
  netProfit: number;
  margin: number;
  operatingSales?: number | null;
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
  const {
    dateRange, setDateRange,
    marketplace, setMarketplace, marketplaceParam,
    dateBasis, setDateBasis, dateBasisParam,
    channel, channelParam,
    localDays, localDaysParam,
    salesMetric,
  } = useFilters();
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  // Top-level Income/Expenses collapse (line items hide; section Total stays visible).
  const [collapsedTop, setCollapsedTop] = useState<Set<string>>(new Set());
  const toggleTop = (key: string) => setCollapsedTop(prev => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });
  const [salesDetailCollapsed, setSalesDetailCollapsed] = useState(false);
  const [returnsCollapsed, setReturnsCollapsed] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    const res = await fetch(`/api/data/profitloss?startDate=${dateRange.startDate}&endDate=${dateRange.endDate}${marketplaceParam}${dateBasisParam}${channelParam}${localDaysParam}`);
    setData(await res.json());
    setLoading(false);
  }, [dateRange, marketplaceParam, dateBasisParam, channelParam, localDaysParam]);

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
    setExpandedSections(new Set(IL_EXPENSE_GROUP_ORDER));
  }

  function collapseAll() {
    setExpandedSections(new Set());
  }

  if (loading || !data) return <PLSkeleton />;

  // Return rate, SellerBoard formula: refunded units / sold units * 100.
  const soldUnits = (data.salesDetail || []).reduce((s, x) => s + (x.quantity || 0), 0);
  const refundedUnits = (data.refundDetail || []).reduce((s, x) => s + (x.quantity || 0), 0);
  const returnRate = soldUnits > 0 ? (refundedUnits / soldUnits) * 100 : 0;

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
      {(channel || localDays) && (
        <div className="mb-4 rounded-lg border border-border-subtle bg-bg-surface px-4 py-2 text-xs text-text-secondary">
          {channel ? `${channel === 'fba' ? 'FBA' : 'FBM'} order-level view` : 'All fulfillment channels'}
          {localDays ? ' · America/Los_Angeles day boundaries' : ''}
          {salesMetric === 'orderTotal' ? ' · Operating Sales uses gross order totals; P&L rows retain recognized accounting components.' : ''}
        </div>
      )}

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        <StatCard
          label={salesMetric === 'orderTotal' && dateBasis === 'purchase' ? 'Operating Sales' : 'Total Revenue'}
          value={salesMetric === 'orderTotal' && dateBasis === 'purchase'
            ? (data.operatingSales ?? data.income.sales)
            : data.income.total}
          format="currency"
          accentColor="default"
        />
        <StatCard label="Total Expenses" value={data.expenses.total} format="currency" accentColor="negative" />
        <StatCard label="Net Profit" value={data.netProfit} format="currency" accentColor={data.netProfit >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Margin" value={data.margin} format="percent" accentColor={data.margin >= 0 ? 'positive' : 'negative'} />
        {/* Return Rate, SellerBoard formula: refunded units ÷ sold units × 100. */}
        <StatCard label="Return Rate" value={returnRate} format="percent" accentColor="default" />
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
            {/* IL-style: refunds + reimbursements fold into Income so Total Income is net. */}
            <SectionHeader label="Income" colorClass="text-accent" collapsed={collapsedTop.has('income')} onToggle={() => toggleTop('income')} />
            {!collapsedTop.has('income') && (<>
              <PLRow label="Sales" amount={data.income.sales} />
              <PLRow label="Refunds Issued" amount={-data.refunds.total} />
              <PLRow label="Fee Clawbacks (on refunds)" amount={data.refunds.clawback} />
              <PLRow label="Reimbursements" amount={data.reimbursements} />
              <PLRow label="MFN Shipping Credits" amount={data.income.shippingCredits} />
              <PLRow label="FBA Shipping Credits" amount={data.income.fbaShippingCredits} />
              <PLRow label="Promotional Rebates" amount={data.income.promoRebates} />
              <PLRow label="Restocking Fees" amount={data.income.restockingFees} />
              <PLRow label="Other Income" amount={data.income.otherIncome} />
            </>)}
            <PLRow
              label="Total Income"
              amount={data.income.total - data.refunds.total + data.refunds.clawback + data.reimbursements}
              bold
            />

            {/* ─── EXPENSES SECTION ─── */}
            <SectionHeader label="Expenses" colorClass="text-negative" collapsed={collapsedTop.has('expenses')} onToggle={() => toggleTop('expenses')} />
            {!collapsedTop.has('expenses') && (<>
              <PLRow label="Cost of Goods Sold" amount={-data.expenses.cogs} />

              {/* Fee groups re-bucketed + relabeled to match Inventory Lab. */}
              {buildILExpenseGroups(
                data.expenses.feeHierarchy,
                data.expenses.otherExpensesByCategory,
                data.expenses.shippingCosts,
                data.expenses.inventoryWriteoff ?? 0,
              ).map(g => (
                <ExpandableSection
                  key={g.group}
                  label={g.group}
                  total={-g.total}
                  children={g.children.map(c => ({ label: c.label, amount: -c.amount }))}
                  expanded={expandedSections.has(g.group)}
                  onToggle={() => toggleSection(g.group)}
                />
              ))}
            </>)}
            <PLRow label="Total Expenses" amount={-data.expenses.total} bold negative />

            {/* ─── NET PROFIT (bound to data.netProfit; tax is a $0 passthrough memo below) ─── */}
            <tr className="border-t-2 border-border-strong bg-bg-elevated">
              <td className="px-4 py-2.5 text-md font-bold text-text-primary">Net Profit</td>
              <td className={`px-4 py-2.5 text-right text-md font-bold font-mono ${data.netProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
                {formatCurrency(data.netProfit)}
              </td>
            </tr>

            {/* ─── SALES TAX (memo — marketplace passthrough, nets to ~$0, excluded from Net Profit) ─── */}
            <tr className="bg-bg-elevated/50">
              <td colSpan={2} className="px-4 py-1.5 text-xs font-semibold tracking-widest uppercase text-text-tertiary">Sales Tax · passthrough</td>
            </tr>
            <PLRow label="Tax Collected" amount={data.salesTax.collected} />
            <PLRow label="Marketplace Facilitator Tax" amount={-data.salesTax.facilitator} />
          </tbody>
        </table>
      </div>

      {/* Sales Detail */}
      {data.salesDetail && data.salesDetail.length > 0 && (
        <div className="mt-6 bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
          <div
            className="flex items-center justify-between px-4 py-3 border-b border-border-subtle cursor-pointer hover:bg-bg-hover transition-colors"
            onClick={() => setSalesDetailCollapsed(c => !c)}
          >
            <div className="flex items-center gap-2">
              <Package size={14} className="text-accent" />
              <span className="text-sm font-semibold text-text-primary">Sales Detail</span>
              <span className="text-xs text-text-tertiary">({data.salesDetail.length} items)</span>
            </div>
            {salesDetailCollapsed
              ? <ChevronDown size={16} className="text-text-tertiary" />
              : <ChevronUp size={16} className="text-text-tertiary" />}
          </div>
          {!salesDetailCollapsed && (
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
                  return (
                    <tr key={`${item.order_id}-${item.sku}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[300px]" title={item.product_name}>{item.product_name}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku}</div>
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge tone={marketplaceTone(item.marketplace)} size="xs">
                          {marketplaceLabel(item.marketplace)}
                        </StatusBadge>
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
          )}
        </div>
      )}

      {/* Refund Detail */}
      {data?.refundDetail && data.refundDetail.length > 0 && (
        <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
          <div
            className="flex items-center justify-between px-4 py-3 border-b border-border-subtle cursor-pointer hover:bg-bg-hover transition-colors"
            onClick={() => setReturnsCollapsed(c => !c)}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-negative">Returns</span>
              <span className="text-xs text-text-tertiary">({data.refundDetail.length} items)</span>
            </div>
            {returnsCollapsed
              ? <ChevronDown size={16} className="text-text-tertiary" />
              : <ChevronUp size={16} className="text-text-tertiary" />}
          </div>
          {!returnsCollapsed && (
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
                  return (
                    <tr key={`refund-${item.order_id}-${i}`} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="px-4 py-2 text-sm">
                        <div className="text-text-primary font-medium truncate max-w-[300px]" title={item.product_name}>{item.product_name}</div>
                        <div className="text-[11px] text-text-tertiary font-mono">{item.sku}</div>
                      </td>
                      <td className="px-4 py-2">
                        <StatusBadge tone={marketplaceTone(item.marketplace)} size="xs">
                          {marketplaceLabel(item.marketplace)}
                        </StatusBadge>
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
          )}
        </div>
      )}
    </div>
  );
}

// ── Inventory Lab-style expense layout (display only — no math change) ────────
// Map raw Amazon fee tokens → IL-style label + group. Re-bucketing changes which
// group a line shows under, never the amounts: every fee is counted exactly once,
// and anything unmapped falls back to "Other Expenses" so nothing is dropped.
const FEE_LABEL_MAP: Record<string, { label: string; group: string }> = {
  Commission:                        { label: 'Amazon Referral Fee',            group: 'Selling Fees' },
  ShippingHB:                        { label: 'Closing Fees',                   group: 'Selling Fees' },
  VariableClosingFee:                { label: 'Closing Fees',                   group: 'Selling Fees' },
  RefundCommission:                  { label: 'Selling Fee Refunds',            group: 'Other Expenses' },
  FBAPerUnitFulfillmentFee:          { label: 'FBA Fulfillment Fees',           group: 'FBA Transaction Fees' },
  ShippingChargeback:                { label: 'Shipping Chargeback',            group: 'FBA Transaction Fees' },
  StorageFee:                        { label: '30 Day Storage Fees',            group: 'FBA Inventory and Inbound Service Fees' },
  StorageRenewalBilling:             { label: 'Long Term Storage Fees',         group: 'FBA Inventory and Inbound Service Fees' },
  RemovalComplete:                   { label: 'Removal Order Fees',             group: 'FBA Inventory and Inbound Service Fees' },
  FBACustomerReturnPerUnitFee:       { label: 'FBA Customer Return Per Unit Fee', group: 'FBA Inventory and Inbound Service Fees' },
  FBAInboundPlacementServiceFee:     { label: 'FBA Inbound Placement Service Fee', group: 'Other Expenses' },
  FBAInboundConvenienceFee:          { label: 'FBA Inbound Convenience Fee',    group: 'Other Expenses' },
  SubscriptionFee:                   { label: 'Amazon Pro Subscription',        group: 'Other Expenses' },
  Shippinglabelpurchaseforreturn:    { label: 'Return Shipping',               group: 'Other Expenses' },
  ReCommerceGradingAndListingCharge: { label: 'Liquidations',                  group: 'Other Expenses' },
  COMPENSATED_CLAWBACK:              { label: 'Compensated Clawback',           group: 'Other Expenses' },
  Adjustment:                        { label: 'Fee Adjustment',                group: 'Other Expenses' },
};

const IL_EXPENSE_GROUP_ORDER = ['Selling Fees', 'FBA Transaction Fees', 'FBA Inventory and Inbound Service Fees', 'Other Expenses'];

function humanizeToken(t: string): string {
  return t.replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\b\w/g, m => m.toUpperCase());
}

type ILExpenseGroup = { group: string; total: number; children: { label: string; amount: number }[] };

// Re-bucket the server's feeHierarchy + other-expenses + MFN shipping into IL's
// groups/labels. Amounts are positive expense magnitudes (rendered negated).
function buildILExpenseGroups(
  feeHierarchy: Record<string, { total: number; children: { name: string; amount: number }[] }>,
  otherExpensesByCategory: { category: string; total: number }[],
  shippingCosts: number,
  inventoryWriteoff: number,
): ILExpenseGroup[] {
  const acc: Record<string, Record<string, number>> = {};
  const add = (group: string, label: string, amount: number) => {
    (acc[group] ||= {});
    acc[group][label] = (acc[group][label] || 0) + amount;
  };
  for (const { children } of Object.values(feeHierarchy)) {
    for (const c of children) {
      const m = FEE_LABEL_MAP[c.name] || { label: humanizeToken(c.name), group: 'Other Expenses' };
      add(m.group, m.label, c.amount);
    }
  }
  for (const c of otherExpensesByCategory) add('Other Expenses', c.category, c.total);
  if (shippingCosts) add('Other Expenses', 'MFN Shipping Label Cost', shippingCosts);
  if (inventoryWriteoff) add('Other Expenses', 'Inventory Write-off', inventoryWriteoff);

  const rank = (g: string) => { const i = IL_EXPENSE_GROUP_ORDER.indexOf(g); return i === -1 ? IL_EXPENSE_GROUP_ORDER.length : i; };
  return Object.entries(acc)
    .map(([group, labels]) => ({
      group,
      total: Object.values(labels).reduce((s, n) => s + n, 0),
      children: Object.entries(labels).map(([label, amount]) => ({ label, amount })).sort((a, b) => b.amount - a.amount),
    }))
    .sort((a, b) => rank(a.group) - rank(b.group));
}

function SectionHeader({ label, colorClass, collapsed, onToggle }: {
  label: string;
  colorClass: string;
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="bg-bg-elevated/50 cursor-pointer hover:bg-bg-elevated transition-colors" onClick={onToggle}>
      <td colSpan={2} className={`px-4 py-1.5 text-xs font-semibold tracking-widest uppercase ${colorClass}`}>
        <span className="inline-flex items-center gap-1.5">
          {label}
          {collapsed ? <ChevronDown size={13} className="opacity-70" /> : <ChevronUp size={13} className="opacity-70" />}
        </span>
      </td>
    </tr>
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
    <tr className="border-b border-border-subtle/60 hover:bg-bg-hover transition-colors">
      <td className={`px-4 py-1 text-[13px] ${bold ? 'font-semibold text-text-primary' : 'text-text-secondary'} ${indent ? 'pl-10' : ''}`}>
        {label}
      </td>
      <td className={`px-4 py-1 text-right text-[13px] font-mono ${
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
      <tr className="border-b border-border-subtle/60 hover:bg-bg-hover transition-colors cursor-pointer" onClick={onToggle}>
        <td className="px-4 py-1 text-[13px] font-medium text-text-primary">
          <div className="flex items-center gap-1.5">
            {expanded ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronRight size={14} className="text-text-tertiary" />}
            {label}
          </div>
        </td>
        <td className={`px-4 py-1 text-right text-[13px] font-mono font-medium ${isNeg ? 'text-negative' : 'text-text-primary'}`}>
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
