'use client';

import { formatCurrency, formatPercent, formatNumber } from '@/lib/formatters';
import { calculatePercentChange } from '@/lib/calculations';

interface StatCardProps {
  label: string;
  value: number;
  previousValue?: number;
  format: 'currency' | 'percent' | 'number';
  accentColor?: 'default' | 'positive' | 'negative' | 'amazon';
}

export default function StatCard({ label, value, previousValue, format, accentColor = 'default' }: StatCardProps) {
  const formatted = format === 'currency'
    ? formatCurrency(value)
    : format === 'percent'
    ? formatPercent(value)
    : formatNumber(value);

  const change = previousValue !== undefined ? calculatePercentChange(value, previousValue) : null;

  const borderColors = {
    default: 'border-t-accent',
    positive: 'border-t-positive',
    negative: 'border-t-negative',
    amazon: 'border-t-amazon',
  };

  return (
    <div className={`bg-bg-surface border border-border-subtle rounded-lg p-5 border-t-2 ${borderColors[accentColor]}`}>
      <div className="text-[11px] font-medium tracking-widest uppercase text-text-tertiary mb-2">
        {label}
      </div>
      <div className="text-2xl font-bold font-mono text-text-primary tracking-tight">
        {formatted}
      </div>
      {change !== null && (
        <div className={`text-xs font-mono mt-1.5 ${change >= 0 ? 'text-positive' : 'text-negative'}`}>
          {change >= 0 ? '+' : ''}{change.toFixed(1)}% vs prev period
        </div>
      )}
    </div>
  );
}
