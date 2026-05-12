'use client';

import DateRangePicker, { type DateRange } from './DateRangePicker';
import MarketplaceFilter from './MarketplaceFilter';
import { Download, Info } from 'lucide-react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  dateRange: DateRange;
  onDateRangeChange: (range: DateRange) => void;
  onExport?: () => void;
  marketplace?: string;
  onMarketplaceChange?: (marketplace: string) => void;
  dateBasis?: string;
  onDateBasisChange?: (basis: string) => void;
}

export default function PageHeader({ title, subtitle, dateRange, onDateRangeChange, onExport, marketplace, onMarketplaceChange, dateBasis, onDateBasisChange }: PageHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="text-sm text-text-tertiary mt-0.5">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-2">
        {onDateBasisChange && (
          <div className="flex h-9 text-sm">
            <div className="relative group">
              <button
                onClick={() => onDateBasisChange('purchase')}
                className={`flex items-center gap-1.5 px-3 h-9 border border-border-default rounded-l-md transition-colors ${
                  dateBasis === 'purchase'
                    ? 'relative z-10 bg-accent/15 text-accent font-medium'
                    : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'
                }`}
              >
                Operating
                <Info size={11} className="shrink-0 opacity-40" />
              </button>
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 p-2.5 bg-bg-elevated border border-border-default rounded-md text-xs text-text-secondary shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 text-left leading-relaxed pointer-events-none">
                Purchase-date view. Best for business performance and Sellerboard-style operating trends. Includes orders based on when they were placed, even if Amazon has not settled the money yet.
              </div>
            </div>
            <div className="relative group -ml-px">
              <button
                onClick={() => onDateBasisChange('posted')}
                className={`flex items-center gap-1.5 px-3 h-9 border border-border-default transition-colors ${
                  dateBasis === 'posted'
                    ? 'relative z-10 bg-accent/15 text-accent font-medium'
                    : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'
                }`}
              >
                Settled
                <Info size={11} className="shrink-0 opacity-40" />
              </button>
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 p-2.5 bg-bg-elevated border border-border-default rounded-md text-xs text-text-secondary shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 text-left leading-relaxed pointer-events-none">
                Posted-event view. Best for DD+7 cash timing. Shows orders and fees when Amazon financial events have posted, so it is closer to cash movement but may still differ from final settlement reports.
              </div>
            </div>
            <div className="relative group -ml-px">
              <button
                onClick={() => onDateBasisChange('reconciled')}
                className={`flex items-center gap-1.5 px-3 h-9 border border-border-default rounded-r-md transition-colors ${
                  dateBasis === 'reconciled'
                    ? 'relative z-10 bg-accent/15 text-accent font-medium'
                    : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'
                }`}
              >
                Accounting
                <Info size={11} className="shrink-0 opacity-40" />
              </button>
              <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 w-64 p-2.5 bg-bg-elevated border border-border-default rounded-md text-xs text-text-secondary shadow-lg opacity-0 group-hover:opacity-100 transition-opacity duration-150 z-50 text-left leading-relaxed pointer-events-none">
                Reconciled settlement view. Best for comparing to InventoryLab reconciled P&amp;L, bookkeeping, and settlement-backed reporting. Use this for the cleanest accounting-style view.
              </div>
            </div>
          </div>
        )}
        {onMarketplaceChange && (
          <MarketplaceFilter value={marketplace || 'all'} onChange={onMarketplaceChange} />
        )}
        <DateRangePicker value={dateRange} onChange={onDateRangeChange} />
        {onExport && (
          <button
            onClick={onExport}
            className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors"
          >
            <Download size={14} className="text-text-tertiary" />
            Export
          </button>
        )}
      </div>
    </div>
  );
}
