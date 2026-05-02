'use client';

import { useState, useRef, useEffect } from 'react';
import { Store, ChevronDown } from 'lucide-react';

interface MarketplaceFilterProps {
  value: string;
  onChange: (marketplace: string) => void;
}

const marketplaces = [
  { label: 'All Marketplaces', value: 'all' },
  { label: 'Amazon', value: 'amazon' },
  { label: 'Walmart', value: 'walmart' },
  { label: 'eBay', value: 'ebay' },
  { label: 'PayPal (Manual)', value: 'paypal' },
];

export default function MarketplaceFilter({ value, onChange }: MarketplaceFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const activeLabel = marketplaces.find(m => m.value === value)?.label || 'All Marketplaces';

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 h-9 px-3 bg-bg-elevated border border-border-default rounded-md text-sm text-text-primary hover:bg-bg-hover transition-colors"
      >
        <Store size={14} className="text-text-tertiary" />
        <span>{activeLabel}</span>
        <ChevronDown size={14} className="text-text-tertiary" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 bg-bg-elevated border border-border-default rounded-md shadow-lg z-50 py-1 min-w-[180px]">
          {marketplaces.map((m) => (
            <button
              key={m.value}
              onClick={() => { onChange(m.value); setOpen(false); }}
              className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                value === m.value
                  ? 'text-accent bg-accent-muted'
                  : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
