'use client';

import DateRangePicker, { type DateRange } from './DateRangePicker';
import MarketplaceFilter from './MarketplaceFilter';
import { Download } from 'lucide-react';

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
          <div className="flex h-9 rounded-md border border-border-default overflow-hidden text-sm">
            <button
              onClick={() => onDateBasisChange('posted')}
              className={`px-3 transition-colors ${
                dateBasis === 'posted'
                  ? 'bg-accent/15 text-accent font-medium'
                  : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'
              }`}
            >
              Cash
            </button>
            <button
              onClick={() => onDateBasisChange('purchase')}
              className={`px-3 border-l border-border-default transition-colors ${
                dateBasis === 'purchase'
                  ? 'bg-accent/15 text-accent font-medium'
                  : 'bg-bg-elevated text-text-secondary hover:bg-bg-hover'
              }`}
            >
              Accrual
            </button>
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
