'use client';

import { useEffect, useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Download, FileText } from 'lucide-react';
import StatCard from '@/components/ui/StatCard';
import YearSelector from '@/components/ui/YearSelector';
import { formatCurrency, formatNumber } from '@/lib/formatters';
import { downloadCsv, centsToDollarStr } from '@/lib/csv-export';

interface TaxData {
  year: number;
  scheduleC: {  // kept as scheduleC in API response for backward compat — maps to Form 1120-S
    line1_grossReceipts: number;     // 1120-S Line 1a
    line2_returnsAllowances: number; // 1120-S Line 1b
    line3_netReceipts: number;       // 1120-S Line 1c
    line4_cogs: number;              // 1120-S Line 2
    line5_grossProfit: number;       // 1120-S Line 3
    line6_otherIncome: number;       // 1120-S Line 4+5
    line7_grossIncome: number;       // 1120-S Line 6
    deductions: {
      amazonFees: number;
      promotionalRebates: number;
      shippingCosts: number;
      otherExpenses: number;
      inboundShipping: number;
    };
    totalDeductions: number;         // 1120-S Line 20
    line31_netProfit: number;        // 1120-S Line 21
  };
  perMarketplace: { marketplace: string; grossReceipts: number; productSales: number; shippingIncome: number; cogs: number; fees: number; refunds: number; clawbacks: number; shippingCosts: number; orders: number; units: number }[];
  incomeByMonth: { month: string; productSales: number; shippingIncome: number; orderCount: number; unitsSold: number }[];
  cogs: { beginningInventory: number; purchases: number; inboundShipping: number; costOfGoodsSold: number; endingInventory: number };
  amazonFees: { category: string; feeType: string; total: number; count: number }[];
  amazonFeeSummary: { category: string; total: number }[];
  otherExpenses: { category: string; total: number; count: number }[];
  salesTaxByState: { state: string; taxCollected: number; facilitatorTax: number; total: number; orderCount: number }[];
  totalTaxCollected: number;
  refundsByMonth: { month: string; count: number; totalRefunded: number; feeClawbacks: number; netCost: number }[];
  reimbursements: { total: number; count: number };
  promos: number;
  shippingCosts: number;
  summary: { totalRevenue: number; totalOrders: number; totalUnits: number; totalRefunds: number; refundCount: number };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function monthLabel(monthStr: string): string {
  const idx = parseInt(monthStr.split('-')[1]) - 1;
  return MONTHS[idx] || monthStr;
}

export default function TaxReportPage() {
  const [data, setData] = useState<TaxData | null>(null);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(new Date().getFullYear() - 1);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/data/tax-report?year=${year}`);
      const json = await res.json();
      setData(json);
    } catch (err) {
      console.error('Failed to load tax report:', err);
    }
    setLoading(false);
  }, [year]);

  useEffect(() => { fetchData(); }, [fetchData]);

  function exportAll() {
    if (!data) return;
    exportScheduleC();
    exportIncomeByMonth();
    exportCogs();
    exportFees();
    exportOtherExpenses();
    exportSalesTax();
    exportRefunds();
  }

  function exportScheduleC() {
    if (!data) return;
    const sc = data.scheduleC;
    downloadCsv(`form-1120s-summary-${year}.csv`,
      ['1120-S Line', 'Description', 'Amount'],
      [
        ['1a', 'Gross Receipts or Sales', centsToDollarStr(sc.line1_grossReceipts)],
        ['1b', 'Returns and Allowances', centsToDollarStr(sc.line2_returnsAllowances)],
        ['1c', 'Net Receipts', centsToDollarStr(sc.line3_netReceipts)],
        ['2', 'Cost of Goods Sold (Schedule A)', centsToDollarStr(sc.line4_cogs)],
        ['3', 'Gross Profit', centsToDollarStr(sc.line5_grossProfit)],
        ['4-5', 'Other Income (Reimbursements + Fee Clawbacks)', centsToDollarStr(sc.line6_otherIncome)],
        ['6', 'Total Income', centsToDollarStr(sc.line7_grossIncome)],
        ['', '', ''],
        ['', 'DEDUCTIONS', ''],
        ['7-19', 'Marketplace Selling & Fulfillment Fees', centsToDollarStr(sc.deductions.amazonFees)],
        ['7-19', 'Promotional Rebates', centsToDollarStr(sc.deductions.promotionalRebates)],
        ['7-19', 'Shipping Costs (MFN Labels)', centsToDollarStr(sc.deductions.shippingCosts)],
        ['7-19', 'Inbound Shipping to FBA/WFS', centsToDollarStr(sc.deductions.inboundShipping)],
        ['7-19', 'Other Business Expenses', centsToDollarStr(sc.deductions.otherExpenses)],
        ['20', 'Total Deductions', centsToDollarStr(sc.totalDeductions)],
        ['', '', ''],
        ['21', 'Ordinary Business Income (or Loss)', centsToDollarStr(sc.line31_netProfit)],
      ]
    );
  }

  function exportIncomeByMonth() {
    if (!data) return;
    downloadCsv(`income-by-month-${year}.csv`,
      ['Month', 'Product Sales', 'Shipping Income', 'Total', 'Orders', 'Units'],
      data.incomeByMonth.map(m => [
        monthLabel(m.month), centsToDollarStr(m.productSales), centsToDollarStr(m.shippingIncome),
        centsToDollarStr(m.productSales + m.shippingIncome), m.orderCount, m.unitsSold,
      ])
    );
  }

  function exportCogs() {
    if (!data) return;
    const c = data.cogs;
    downloadCsv(`cogs-schedule-a-${year}.csv`,
      ['1120-S Schedule A Line', 'Description', 'Amount'],
      [
        ['1', 'Inventory at Beginning of Year', centsToDollarStr(c.beginningInventory)],
        ['2', 'Purchases', centsToDollarStr(c.purchases)],
        ['3', 'Cost of Labor', '0.00'],
        ['4', 'Additional Section 263A Costs', '0.00'],
        ['5', 'Other Costs (Inbound Shipping)', centsToDollarStr(c.inboundShipping)],
        ['6', 'Total (Lines 1-5)', centsToDollarStr(c.beginningInventory + c.purchases + c.inboundShipping)],
        ['7', 'Inventory at End of Year', centsToDollarStr(c.endingInventory)],
        ['8', 'Cost of Goods Sold (Line 6 - Line 7)', centsToDollarStr(c.costOfGoodsSold)],
        ['9a', 'Method of Valuation: FIFO', ''],
      ]
    );
  }

  function exportFees() {
    if (!data) return;
    downloadCsv(`amazon-fees-detail-${year}.csv`,
      ['Category', 'Fee Type', 'Amount', 'Count'],
      data.amazonFees.map(f => [f.category, f.feeType, centsToDollarStr(f.total), f.count])
    );
  }

  function exportOtherExpenses() {
    if (!data) return;
    downloadCsv(`other-expenses-${year}.csv`,
      ['Category', 'Amount', 'Transactions'],
      data.otherExpenses.map(e => [e.category, centsToDollarStr(e.total), e.count])
    );
  }

  function exportSalesTax() {
    if (!data) return;
    downloadCsv(`sales-tax-by-state-${year}.csv`,
      ['State', 'Tax Collected', 'Marketplace Facilitator Tax', 'Total', 'Orders'],
      data.salesTaxByState.map(s => [s.state, centsToDollarStr(s.taxCollected), centsToDollarStr(s.facilitatorTax), centsToDollarStr(s.total), s.orderCount])
    );
  }

  function exportRefunds() {
    if (!data) return;
    downloadCsv(`refunds-by-month-${year}.csv`,
      ['Month', 'Count', 'Total Refunded', 'Fee Clawbacks', 'Net Cost'],
      data.refundsByMonth.map(r => [monthLabel(r.month), r.count, centsToDollarStr(r.totalRefunded), centsToDollarStr(r.feeClawbacks), centsToDollarStr(r.netCost)])
    );
  }

  if (loading || !data) return <TaxReportSkeleton />;

  const sc = data.scheduleC;
  const margin = sc.line1_grossReceipts > 0 ? (sc.line31_netProfit / sc.line1_grossReceipts) * 100 : 0;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
            <FileText size={20} className="text-accent" />
            Tax Report — {year}
          </h1>
          <p className="text-sm text-text-tertiary mt-0.5">Everything your CPA needs for Form 1120-S</p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={exportAll}
            className="flex items-center gap-2 h-9 px-4 bg-accent text-white rounded-md text-sm font-medium hover:bg-accent-hover transition-colors"
          >
            <Download size={14} />
            Export All CSVs
          </button>
          <YearSelector year={year} onChange={setYear} />
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Gross Revenue" value={sc.line1_grossReceipts} format="currency" accentColor="default" />
        <StatCard label="Total Deductions" value={sc.totalDeductions + sc.line4_cogs + sc.line2_returnsAllowances} format="currency" accentColor="negative" />
        <StatCard label="Net Profit" value={sc.line31_netProfit} format="currency" accentColor={sc.line31_netProfit >= 0 ? 'positive' : 'negative'} />
        <StatCard label="Profit Margin" value={margin} format="percent" accentColor={margin >= 0 ? 'positive' : 'negative'} />
      </div>

      {/* Sections */}
      <div className="space-y-4">
        {/* Schedule C Summary */}
        <TaxSection title="Form 1120-S Summary" description="Maps to IRS Form 1120-S (S-Corporation) income and deductions" onExport={exportScheduleC}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider w-20">Line</th>
                <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Description</th>
                <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider w-40">Amount</th>
              </tr>
            </thead>
            <tbody>
              <ScheduleRow line="1a" label="Gross Receipts or Sales" value={sc.line1_grossReceipts} />
              <ScheduleRow line="1b" label="Returns and Allowances" value={sc.line2_returnsAllowances} negative />
              <ScheduleRow line="1c" label="Net Receipts" value={sc.line3_netReceipts} bold />
              <ScheduleRow line="2" label="Cost of Goods Sold (Schedule A)" value={sc.line4_cogs} negative />
              <ScheduleRow line="3" label="Gross Profit" value={sc.line5_grossProfit} bold />
              <ScheduleRow line="4-5" label="Other Income (Reimbursements + Clawbacks)" value={sc.line6_otherIncome} />
              <ScheduleRow line="6" label="Total Income" value={sc.line7_grossIncome} bold />
              <tr><td colSpan={3} className="py-2"></td></tr>
              <tr className="border-t border-border-subtle">
                <td className="py-2 text-text-tertiary font-mono text-xs"></td>
                <td className="py-2 text-text-secondary font-semibold text-xs uppercase tracking-wider">Deductions (Lines 7-19)</td>
                <td></td>
              </tr>
              <ScheduleRow line="7-19" label="Marketplace Selling & Fulfillment Fees" value={sc.deductions.amazonFees} negative />
              <ScheduleRow line="7-19" label="Promotional Rebates" value={sc.deductions.promotionalRebates} negative />
              <ScheduleRow line="7-19" label="Shipping Costs (MFN Labels)" value={sc.deductions.shippingCosts} negative />
              <ScheduleRow line="7-19" label="Inbound Shipping to FBA/WFS" value={sc.deductions.inboundShipping} negative />
              <ScheduleRow line="7-19" label="Other Business Expenses" value={sc.deductions.otherExpenses} negative />
              <ScheduleRow line="20" label="Total Deductions" value={sc.totalDeductions} bold negative />
              <tr><td colSpan={3} className="py-1"></td></tr>
              <tr className="border-t-2 border-accent">
                <td className="py-3 font-mono text-xs text-accent">21</td>
                <td className="py-3 font-semibold text-text-primary">Ordinary Business Income (or Loss)</td>
                <td className={`py-3 text-right font-mono font-bold text-base ${sc.line31_netProfit >= 0 ? 'text-positive' : 'text-negative'}`}>
                  {formatCurrency(sc.line31_netProfit)}
                </td>
              </tr>
            </tbody>
          </table>
        </TaxSection>

        {/* Marketplace Breakdown */}
        {data.perMarketplace && data.perMarketplace.length > 1 && (
          <TaxSection title="Breakdown by Marketplace" description="Per-marketplace income, COGS, fees, and refunds for your CPA" onExport={() => {
            if (!data) return;
            downloadCsv(`marketplace-breakdown-${year}.csv`,
              ['Marketplace', 'Gross Receipts', 'Product Sales', 'Shipping Income', 'COGS', 'Marketplace Fees', 'Refunds', 'Fee Clawbacks', 'Shipping Costs', 'Orders', 'Units'],
              data.perMarketplace.map(m => [
                m.marketplace.charAt(0).toUpperCase() + m.marketplace.slice(1),
                centsToDollarStr(m.grossReceipts), centsToDollarStr(m.productSales), centsToDollarStr(m.shippingIncome),
                centsToDollarStr(m.cogs), centsToDollarStr(m.fees), centsToDollarStr(m.refunds), centsToDollarStr(m.clawbacks),
                centsToDollarStr(m.shippingCosts), m.orders, m.units,
              ])
            );
          }}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Marketplace</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Gross Receipts</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">COGS</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Fees</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Refunds</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Shipping</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Orders</th>
                </tr>
              </thead>
              <tbody>
                {data.perMarketplace.map(m => {
                  const netIncome = m.grossReceipts - m.cogs - m.fees - m.refunds + m.clawbacks - m.shippingCosts;
                  return (
                    <tr key={m.marketplace} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="py-2 text-text-primary font-medium capitalize">{m.marketplace}</td>
                      <td className="py-2 text-right font-mono text-text-primary">{formatCurrency(m.grossReceipts)}</td>
                      <td className="py-2 text-right font-mono text-negative">{formatCurrency(m.cogs)}</td>
                      <td className="py-2 text-right font-mono text-negative">{formatCurrency(m.fees)}</td>
                      <td className="py-2 text-right font-mono text-negative">{formatCurrency(m.refunds)}</td>
                      <td className="py-2 text-right font-mono text-negative">{formatCurrency(m.shippingCosts)}</td>
                      <td className="py-2 text-right font-mono text-text-secondary">{formatNumber(m.orders)}</td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-border-subtle font-semibold">
                  <td className="py-2 text-text-primary">Total</td>
                  <td className="py-2 text-right font-mono">{formatCurrency(data.perMarketplace.reduce((s, m) => s + m.grossReceipts, 0))}</td>
                  <td className="py-2 text-right font-mono">{formatCurrency(data.perMarketplace.reduce((s, m) => s + m.cogs, 0))}</td>
                  <td className="py-2 text-right font-mono">{formatCurrency(data.perMarketplace.reduce((s, m) => s + m.fees, 0))}</td>
                  <td className="py-2 text-right font-mono">{formatCurrency(data.perMarketplace.reduce((s, m) => s + m.refunds, 0))}</td>
                  <td className="py-2 text-right font-mono">{formatCurrency(data.perMarketplace.reduce((s, m) => s + m.shippingCosts, 0))}</td>
                  <td className="py-2 text-right font-mono">{formatNumber(data.perMarketplace.reduce((s, m) => s + m.orders, 0))}</td>
                </tr>
              </tbody>
            </table>
          </TaxSection>
        )}

        {/* Income by Month */}
        <TaxSection title="Income by Month" description="Monthly revenue breakdown for quarterly estimated tax planning" onExport={exportIncomeByMonth}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Month</th>
                <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Product Sales</th>
                <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Shipping</th>
                <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Total</th>
                <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Orders</th>
                <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Units</th>
              </tr>
            </thead>
            <tbody>
              {data.incomeByMonth.map(m => (
                <tr key={m.month} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                  <td className="py-2 text-text-primary">{monthLabel(m.month)}</td>
                  <td className="py-2 text-right font-mono text-text-primary">{formatCurrency(m.productSales)}</td>
                  <td className="py-2 text-right font-mono text-text-secondary">{formatCurrency(m.shippingIncome)}</td>
                  <td className="py-2 text-right font-mono text-text-primary font-medium">{formatCurrency(m.productSales + m.shippingIncome)}</td>
                  <td className="py-2 text-right font-mono text-text-secondary">{formatNumber(m.orderCount)}</td>
                  <td className="py-2 text-right font-mono text-text-secondary">{formatNumber(m.unitsSold)}</td>
                </tr>
              ))}
              <tr className="border-t-2 border-border-subtle font-semibold">
                <td className="py-2 text-text-primary">Total</td>
                <td className="py-2 text-right font-mono">{formatCurrency(data.incomeByMonth.reduce((s, m) => s + m.productSales, 0))}</td>
                <td className="py-2 text-right font-mono">{formatCurrency(data.incomeByMonth.reduce((s, m) => s + m.shippingIncome, 0))}</td>
                <td className="py-2 text-right font-mono">{formatCurrency(data.incomeByMonth.reduce((s, m) => s + m.productSales + m.shippingIncome, 0))}</td>
                <td className="py-2 text-right font-mono">{formatNumber(data.incomeByMonth.reduce((s, m) => s + m.orderCount, 0))}</td>
                <td className="py-2 text-right font-mono">{formatNumber(data.incomeByMonth.reduce((s, m) => s + m.unitsSold, 0))}</td>
              </tr>
            </tbody>
          </table>
        </TaxSection>

        {/* COGS Calculation */}
        <TaxSection title="Cost of Goods Sold (Schedule A)" description="Form 1120-S Schedule A — Inventory and COGS calculation using FIFO method" onExport={exportCogs}>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle">
                <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider w-20">Line</th>
                <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Description</th>
                <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider w-40">Amount</th>
              </tr>
            </thead>
            <tbody>
              <ScheduleRow line="1" label="Inventory at Beginning of Year" value={data.cogs.beginningInventory} />
              <ScheduleRow line="2" label="Purchases" value={data.cogs.purchases} />
              <ScheduleRow line="3" label="Cost of Labor" value={0} />
              <ScheduleRow line="4" label="Additional Section 263A Costs" value={0} />
              <ScheduleRow line="5" label="Other Costs (Inbound Shipping)" value={data.cogs.inboundShipping} />
              <ScheduleRow line="6" label="Total (Add Lines 1-5)" value={data.cogs.beginningInventory + data.cogs.purchases + data.cogs.inboundShipping} bold />
              <ScheduleRow line="7" label="Inventory at End of Year" value={data.cogs.endingInventory} />
              <tr className="border-t-2 border-border-subtle">
                <td className="py-2 font-mono text-xs text-accent">8</td>
                <td className="py-2 font-semibold text-text-primary">Cost of Goods Sold (Line 6 - Line 7)</td>
                <td className="py-2 text-right font-mono font-bold">{formatCurrency(data.cogs.costOfGoodsSold)}</td>
              </tr>
              <ScheduleRow line="9a" label="Method of valuation: FIFO (First In, First Out)" value={0} hideValue />
            </tbody>
          </table>
        </TaxSection>

        {/* Amazon Fee Breakdown */}
        <TaxSection title="Marketplace Fee Breakdown" description="All selling fees, fulfillment fees, and service fees — deductible business expenses" onExport={exportFees}>
          {data.amazonFeeSummary.map(cat => {
            const children = data.amazonFees.filter(f => f.category === cat.category);
            return <FeeCategory key={cat.category} category={cat.category} total={cat.total} children={children} />;
          })}
          <div className="flex justify-between py-3 border-t-2 border-border-subtle font-semibold text-sm">
            <span>Total Marketplace Fees</span>
            <span className="font-mono">{formatCurrency(data.amazonFeeSummary.reduce((s, c) => s + c.total, 0))}</span>
          </div>
        </TaxSection>

        {/* Other Business Expenses */}
        <TaxSection title="Other Business Expenses" description="Non-marketplace expenses — Subscriptions, insurance, software, etc. (Form 1120-S Lines 7-19)" onExport={exportOtherExpenses}>
          {data.otherExpenses.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Category</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Amount</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Transactions</th>
                </tr>
              </thead>
              <tbody>
                {data.otherExpenses.map(e => (
                  <tr key={e.category} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                    <td className="py-2 text-text-primary">{e.category}</td>
                    <td className="py-2 text-right font-mono text-negative">{formatCurrency(e.total)}</td>
                    <td className="py-2 text-right font-mono text-text-secondary">{e.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-text-tertiary py-4">No other expenses recorded for {year}. Add expenses through the Other Expenses page.</p>
          )}
        </TaxSection>

        {/* Sales Tax by State */}
        <TaxSection title="Sales Tax by State" description="Reference only — Amazon/Walmart collect and remit as marketplace facilitators. Not reported on Form 1120-S." onExport={exportSalesTax}>
          {data.salesTaxByState.length > 0 ? (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border-subtle">
                    <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">State</th>
                    <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Tax Collected</th>
                    <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Facilitator Tax</th>
                    <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Orders</th>
                  </tr>
                </thead>
                <tbody>
                  {data.salesTaxByState.map(s => (
                    <tr key={s.state} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                      <td className="py-2 text-text-primary font-medium">{s.state}</td>
                      <td className="py-2 text-right font-mono text-text-primary">{formatCurrency(s.taxCollected)}</td>
                      <td className="py-2 text-right font-mono text-text-secondary">{formatCurrency(s.facilitatorTax)}</td>
                      <td className="py-2 text-right font-mono text-text-secondary">{formatNumber(s.orderCount)}</td>
                    </tr>
                  ))}
                  <tr className="border-t-2 border-border-subtle font-semibold">
                    <td className="py-2">Total</td>
                    <td className="py-2 text-right font-mono">{formatCurrency(data.totalTaxCollected)}</td>
                    <td className="py-2 text-right font-mono">{formatCurrency(data.salesTaxByState.reduce((s, r) => s + r.facilitatorTax, 0))}</td>
                    <td className="py-2 text-right font-mono">{formatNumber(data.salesTaxByState.reduce((s, r) => s + r.orderCount, 0))}</td>
                  </tr>
                </tbody>
              </table>
              <div className="mt-3 p-3 bg-bg-root rounded-lg border border-border-subtle">
                <p className="text-xs text-text-secondary font-medium mb-1">You do NOT need to do anything with this data.</p>
                <p className="text-xs text-text-tertiary">Amazon and Walmart collect and remit sales tax as marketplace facilitators in all applicable states. This tax is withheld from your payouts before you receive them — it is not your income and not your expense. This section is for your records only.</p>
              </div>
            </>
          ) : (
            <p className="text-sm text-text-tertiary py-4">No sales tax data recorded for {year}.</p>
          )}
        </TaxSection>

        {/* Refunds & Adjustments */}
        <TaxSection title="Refunds & Adjustments" description="Customer refunds reduce gross receipts; fee clawbacks are included in other income" onExport={exportRefunds}>
          <div className="grid grid-cols-3 gap-4 mb-4">
            <div className="bg-bg-root rounded-lg p-3">
              <div className="text-[10px] font-medium tracking-widest uppercase text-text-tertiary mb-1">Total Refunded</div>
              <div className="text-lg font-bold font-mono text-negative">{formatCurrency(data.refundsByMonth.reduce((s, r) => s + r.totalRefunded, 0))}</div>
            </div>
            <div className="bg-bg-root rounded-lg p-3">
              <div className="text-[10px] font-medium tracking-widest uppercase text-text-tertiary mb-1">Fee Clawbacks</div>
              <div className="text-lg font-bold font-mono text-positive">{formatCurrency(data.refundsByMonth.reduce((s, r) => s + r.feeClawbacks, 0))}</div>
            </div>
            <div className="bg-bg-root rounded-lg p-3">
              <div className="text-[10px] font-medium tracking-widest uppercase text-text-tertiary mb-1">Reimbursements</div>
              <div className="text-lg font-bold font-mono text-positive">{formatCurrency(data.reimbursements.total)}</div>
            </div>
          </div>
          {data.refundsByMonth.length > 0 ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle">
                  <th className="text-left py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Month</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Refunds</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Refunded</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Clawbacks</th>
                  <th className="text-right py-2 text-text-tertiary font-medium text-xs uppercase tracking-wider">Net Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.refundsByMonth.map(r => (
                  <tr key={r.month} className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
                    <td className="py-2 text-text-primary">{monthLabel(r.month)}</td>
                    <td className="py-2 text-right font-mono text-text-secondary">{r.count}</td>
                    <td className="py-2 text-right font-mono text-negative">{formatCurrency(r.totalRefunded)}</td>
                    <td className="py-2 text-right font-mono text-positive">{formatCurrency(r.feeClawbacks)}</td>
                    <td className="py-2 text-right font-mono text-negative">{formatCurrency(r.netCost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="text-sm text-text-tertiary py-2">No refunds recorded for {year}.</p>
          )}
        </TaxSection>
      </div>
    </div>
  );
}

// ─── Helper Components ──────────────────────────────────────────────────────

function TaxSection({ title, description, onExport, children }: {
  title: string; description: string; onExport: () => void; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-bg-surface border border-border-subtle rounded-lg overflow-hidden">
      {/* Header row: left side (collapse toggle) and right side (CSV export) are
          siblings, not nested buttons. Nesting a <button> inside another
          <button> is invalid HTML and causes a React hydration error. */}
      <div className="flex items-center justify-between p-4 hover:bg-bg-hover transition-colors">
        <button
          onClick={() => setOpen(!open)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
          aria-expanded={open}
        >
          {open ? <ChevronDown size={16} className="text-text-tertiary shrink-0" /> : <ChevronRight size={16} className="text-text-tertiary shrink-0" />}
          <div className="min-w-0">
            <div className="text-sm font-semibold text-text-primary">{title}</div>
            <div className="text-xs text-text-tertiary mt-0.5">{description}</div>
          </div>
        </button>
        <button
          onClick={onExport}
          className="flex items-center gap-1.5 h-7 px-3 bg-bg-elevated border border-border-default rounded-md text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors shrink-0 ml-3"
        >
          <Download size={12} />
          CSV
        </button>
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </div>
  );
}

function ScheduleRow({ line, label, value, bold, negative, hideValue }: {
  line: string; label: string; value: number; bold?: boolean; negative?: boolean; hideValue?: boolean;
}) {
  return (
    <tr className="border-b border-border-subtle/50 hover:bg-bg-hover transition-colors">
      <td className="py-2 font-mono text-xs text-text-tertiary">{line}</td>
      <td className={`py-2 ${bold ? 'font-semibold text-text-primary' : 'text-text-secondary'}`}>{label}</td>
      <td className={`py-2 text-right font-mono ${hideValue ? '' : bold ? 'font-semibold' : ''} ${negative && value > 0 ? 'text-negative' : ''}`}>
        {hideValue ? '' : formatCurrency(value)}
      </td>
    </tr>
  );
}

function FeeCategory({ category, total, children }: {
  category: string; total: number; children: { feeType: string; total: number; count: number }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border-b border-border-subtle/50">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between py-2 hover:bg-bg-hover transition-colors text-sm">
        <div className="flex items-center gap-2">
          {open ? <ChevronDown size={14} className="text-text-tertiary" /> : <ChevronRight size={14} className="text-text-tertiary" />}
          <span className="text-text-primary font-medium">{category}</span>
          <span className="text-text-tertiary text-xs">({children.length} fee types)</span>
        </div>
        <span className="font-mono text-negative">{formatCurrency(total)}</span>
      </button>
      {open && (
        <div className="pl-7 pb-2 space-y-1">
          {children.map((f, i) => (
            <div key={i} className="flex justify-between text-xs text-text-secondary py-0.5">
              <span>{f.feeType} <span className="text-text-tertiary">({f.count})</span></span>
              <span className="font-mono">{formatCurrency(f.total)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function TaxReportSkeleton() {
  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="skeleton h-6 w-48 mb-2" />
          <div className="skeleton h-4 w-64" />
        </div>
        <div className="flex gap-3">
          <div className="skeleton h-9 w-36" />
          <div className="skeleton h-9 w-24" />
        </div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-bg-surface border border-border-subtle rounded-lg p-5">
            <div className="skeleton h-3 w-24 mb-3" />
            <div className="skeleton h-8 w-32" />
          </div>
        ))}
      </div>
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="bg-bg-surface border border-border-subtle rounded-lg p-4">
            <div className="skeleton h-5 w-48 mb-2" />
            <div className="skeleton h-3 w-72" />
          </div>
        ))}
      </div>
    </div>
  );
}
