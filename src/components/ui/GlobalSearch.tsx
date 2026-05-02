'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Search, ShoppingCart, HandCoins, ShoppingBag, Loader2, ScanBarcode } from 'lucide-react';

interface LookupResult {
  type: 'order' | 'reimbursement' | 'product' | 'refund' | 'batch';
  id: string;
  href: string;
  title: string;
  subtitle?: string;
  marketplace?: string;
  amountCents?: number;
  date?: string;
}

const typeMeta: Record<LookupResult['type'], { label: string; icon: React.ReactNode; color: string }> = {
  order: { label: 'Order', icon: <ShoppingCart size={14} />, color: 'text-accent' },
  reimbursement: { label: 'Reimb', icon: <HandCoins size={14} />, color: 'text-positive' },
  product: { label: 'Product', icon: <ShoppingBag size={14} />, color: 'text-text-secondary' },
  refund: { label: 'Refund', icon: <HandCoins size={14} />, color: 'text-warning' },
  batch: { label: 'Batch', icon: <ScanBarcode size={14} />, color: 'text-accent' },
};

const marketplaceBadge: Record<string, { label: string; cls: string }> = {
  amazon: { label: 'AMZ', cls: 'bg-orange-500/10 text-orange-400' },
  walmart: { label: 'WMT', cls: 'bg-blue-500/10 text-blue-400' },
  ebay: { label: 'EBAY', cls: 'bg-green-500/10 text-green-400' },
  paypal: { label: 'PP', cls: 'bg-cyan-500/10 text-cyan-400' },
};

function formatCents(cents?: number): string {
  if (cents === undefined || cents === null) return '';
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toFixed(2)}`;
}

interface Props {
  collapsed?: boolean;
}

export default function GlobalSearch({ collapsed = false }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<LookupResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);

  // Cmd/Ctrl + K to focus
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, []);

  // Click outside to close
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Debounced fetch
  const runQuery = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (q.trim().length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => {
      fetch(`/api/data/lookup?q=${encodeURIComponent(q)}`)
        .then((r) => r.json())
        .then((data) => {
          setResults(data.results || []);
          setActiveIdx(0);
        })
        .catch(() => setResults([]))
        .finally(() => setLoading(false));
    }, 200);
  }, []);

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = e.target.value;
    setQuery(v);
    setOpen(true);
    runQuery(v);
  }

  function navigateTo(r: LookupResult) {
    setOpen(false);
    setQuery('');
    setResults([]);
    router.push(r.href);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIdx((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      if (results[activeIdx]) {
        e.preventDefault();
        navigateTo(results[activeIdx]);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  // Collapsed mode: show just the icon button
  if (collapsed) {
    return (
      <button
        onClick={() => {
          inputRef.current?.focus();
          setOpen(true);
        }}
        className="w-full flex items-center justify-center h-8 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-colors"
        title="Search (⌘K)"
      >
        <Search size={18} />
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-text-tertiary pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          placeholder="Search orders, SKUs, IDs…"
          onChange={handleChange}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          className="w-full h-8 pl-8 pr-12 bg-bg-elevated border border-border-subtle rounded-md text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-accent transition-colors"
        />
        <kbd className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-text-tertiary px-1.5 py-0.5 rounded bg-bg-surface border border-border-subtle pointer-events-none">⌘K</kbd>
      </div>

      {open && query.trim().length >= 2 && (
        <div className="absolute left-0 right-0 mt-1 z-50 bg-bg-surface border border-border-subtle rounded-md shadow-lg max-h-[28rem] overflow-y-auto">
          {loading && results.length === 0 && (
            <div className="flex items-center gap-2 px-3 py-3 text-sm text-text-tertiary">
              <Loader2 size={14} className="animate-spin" />
              Searching…
            </div>
          )}
          {!loading && results.length === 0 && (
            <div className="px-3 py-3 text-sm text-text-tertiary">No matches.</div>
          )}
          {results.map((r, i) => {
            const tm = typeMeta[r.type];
            const mb = r.marketplace ? marketplaceBadge[r.marketplace] : null;
            return (
              <button
                key={`${r.type}-${r.id}-${i}`}
                onClick={() => navigateTo(r)}
                onMouseEnter={() => setActiveIdx(i)}
                className={`w-full flex items-start gap-2 px-3 py-2 text-left border-l-2 transition-colors ${
                  i === activeIdx
                    ? 'bg-bg-active border-accent'
                    : 'border-transparent hover:bg-bg-hover'
                }`}
              >
                <span className={`shrink-0 mt-0.5 ${tm.color}`}>{tm.icon}</span>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-[10px] font-medium tracking-wider uppercase text-text-tertiary">
                      {tm.label}
                    </span>
                    {mb && (
                      <span className={`px-1 py-0.5 text-[9px] font-medium rounded ${mb.cls}`}>
                        {mb.label}
                      </span>
                    )}
                    {r.amountCents !== undefined && (
                      <span className={`ml-auto text-xs ${r.amountCents < 0 ? 'text-negative' : 'text-text-secondary'}`}>
                        {formatCents(r.amountCents)}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-text-primary truncate font-mono">{r.title}</div>
                  {r.subtitle && (
                    <div className="text-xs text-text-tertiary truncate mt-0.5">{r.subtitle}</div>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
