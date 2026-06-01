'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  Warehouse,
  Truck,
  Undo2,
  CircleAlert,
  BarChart3,
  Wrench,
  Menu,
  X,
  Search,
} from 'lucide-react';
import { useState, useEffect, useRef } from 'react';
import GlobalSearch from '@/components/ui/GlobalSearch';

interface SubItem {
  label: string;
  href: string;
}

interface NavSection {
  key: string;
  label: string;
  icon: React.ReactNode;
  href?: string;          // direct destination (sections with no sub-items)
  items?: SubItem[];      // flyout sub-pages
  attention?: boolean;    // show orange badge slot (Problems)
}

// Consolidated, workflow-oriented nav. Each top section opens a flyout of its
// pages (Phase 1). Phase 2 will replace flyouts with PSH-style landing hubs.
const NAV: NavSection[] = [
  { key: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard size={21} />, href: '/' },
  {
    key: 'inventory', label: 'Inventory', icon: <Warehouse size={21} />,
    items: [
      { label: 'Products & COGS', href: '/products' },
      { label: 'Merchant Inventory', href: '/analyze/merchant-inventory' },
      { label: 'Inventory Valuation', href: '/analyze/inventory-valuation' },
      { label: 'MFN Quick Tray', href: '/mfn/batch' },
      { label: 'MFN Upload List', href: '/mfn/upload-list' },
    ],
  },
  {
    key: 'shipments', label: 'Shipments', icon: <Truck size={21} />,
    items: [
      { label: 'Batches', href: '/list' },
      { label: 'MFN Orders', href: '/mfn/orders' },
      { label: 'Labels', href: '/labels' },
      { label: 'Inbound Shipping', href: '/bookkeep/inbound-shipping' },
    ],
  },
  {
    key: 'returns', label: 'Returns', icon: <Undo2 size={21} />,
    items: [
      { label: 'Refunds', href: '/bookkeep/refunds' },
      { label: 'Removals', href: '/analyze/removals' },
    ],
  },
  {
    key: 'problems', label: 'Problems', icon: <CircleAlert size={21} />, attention: true,
    items: [
      { label: 'Claims to File', href: '/bookkeep/claims-to-file' },
      { label: 'Reimbursements', href: '/bookkeep/reimbursements' },
      { label: 'Reimbursement Re-Evaluations', href: '/bookkeep/reimbursement-reevaluations' },
      { label: 'Amazon Disputes', href: '/bookkeep/amazon-disputes' },
      { label: 'Walmart Disputes', href: '/bookkeep/walmart-disputes' },
    ],
  },
  {
    key: 'reports', label: 'Reports', icon: <BarChart3 size={21} />,
    items: [
      { label: 'Profit & Loss', href: '/analyze/profitloss' },
      { label: 'FBA Sales', href: '/bookkeep/fba-sales' },
      { label: 'WFS Sales', href: '/bookkeep/wfs-sales' },
      { label: 'Merchant Sales', href: '/bookkeep/merchant-sales' },
      { label: 'eBay Sales', href: '/bookkeep/ebay-sales' },
      { label: 'ASIN Profitability', href: '/analyze/asin-profitability' },
      { label: 'SKU Profitability', href: '/analyze/sku-profitability' },
      { label: 'Supplier Profitability', href: '/analyze/supplier-profitability' },
      { label: 'Sales Tax', href: '/analyze/salestax' },
      { label: 'Tax Report', href: '/tax-report' },
      { label: 'Other Expenses', href: '/bookkeep/other-expenses' },
    ],
  },
  {
    key: 'tools', label: 'Tools', icon: <Wrench size={21} />,
    items: [
      { label: 'Sync', href: '/sync' },
      { label: 'Settings', href: '/settings' },
    ],
  },
];

function formatSyncTime(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'Synced just now';
  if (mins < 60) return `Synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${new Date(isoDate).toLocaleDateString()}`;
}

/** A section is active if the current path matches its direct href or any sub-item. */
function isSectionActive(section: NavSection, pathname: string): boolean {
  if (section.href) return pathname === section.href;
  return (section.items || []).some((i) => pathname === i.href || pathname.startsWith(i.href + '/'));
}

export default function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState<string | null>(null);   // flyout section key
  const [mobileOpen, setMobileOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const searchRef = useRef<HTMLDivElement>(null);

  const fetchLastSync = () => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => { if (data.settings?.lastSync) setLastSync(data.settings.lastSync); })
      .catch(() => {});
  };

  useEffect(() => {
    fetchLastSync();
    fetch('/api/sync/auto').catch(() => {});
    const interval = setInterval(fetchLastSync, 60000);
    return () => clearInterval(interval);
  }, []);

  // Open the rail search before its input mounts so the existing shortcut remains useful.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(null);
        setSearchOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  // Focus the mounted input and close the search popover on outside-click or Escape.
  useEffect(() => {
    if (!searchOpen) return;
    searchRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    const onDown = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setSearchOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSearchOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [searchOpen]);

  return (
    <>
      {/* Mobile hamburger */}
      <button
        onClick={() => setMobileOpen(true)}
        className="fixed top-4 left-4 z-50 p-2 rounded-md bg-bg-surface border border-border-subtle lg:hidden"
        aria-label="Open navigation"
      >
        <Menu size={20} className="text-text-secondary" />
      </button>

      {/* Mobile overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => { setMobileOpen(false); setOpen(null); setSearchOpen(false); }} />
      )}

      {/* Narrow rail */}
      <aside
        className={`
          fixed top-0 left-0 z-50 h-screen w-20 bg-bg-surface border-r border-border-subtle
          flex flex-col items-center transition-transform duration-200 ease-in-out
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0 lg:relative lg:z-auto
        `}
      >
        {/* Logo mark */}
        <Link
          href="/"
          onClick={() => { setMobileOpen(false); setOpen(null); setSearchOpen(false); }}
          className="flex h-14 w-full items-center justify-center border-b border-border-subtle text-sm font-bold tracking-tight text-text-primary"
          title="FlipLedger"
        >
          FL
        </Link>

        {/* Search — tile opens a popover with the full (working) search */}
        <div ref={searchRef} className="relative w-full px-2 pt-3 pb-1 flex justify-center">
          <button
            type="button"
            onClick={() => { setOpen(null); setSearchOpen((v) => !v); }}
            title="Search (⌘K)"
            className={`flex w-16 flex-col items-center gap-1 rounded-lg py-2.5 text-[10px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg-surface ${
              searchOpen ? 'bg-accent/15 text-accent' : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
            }`}
          >
            <Search size={21} />
            <span className="leading-none">Search</span>
          </button>
          {searchOpen && (
            <div className="absolute left-full top-3 z-50 ml-1 w-72 rounded-lg border border-border-default bg-bg-surface p-2 shadow-2xl">
              <GlobalSearch onNavigate={() => setSearchOpen(false)} />
            </div>
          )}
        </div>

        {/* Sections */}
        <nav className="flex-1 w-full py-2 flex flex-col items-center gap-1">
          {NAV.map((section) => {
            const active = isSectionActive(section, pathname);
            const hasItems = !!section.items?.length;
            const tileClass = `relative flex w-16 flex-col items-center gap-1 rounded-lg py-2.5 text-[10px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-bg-surface ${
              active
                ? 'bg-accent/15 text-accent'
                : 'text-text-tertiary hover:bg-bg-hover hover:text-text-primary'
            }`;

            return (
              <div
                key={section.key}
                className="relative"
                onMouseEnter={() => {
                  if (hasItems) {
                    setSearchOpen(false);
                    setOpen(section.key);
                  }
                }}
                onMouseLeave={() => setOpen((k) => (k === section.key ? null : k))}
              >
                {hasItems ? (
                  <button
                    type="button"
                    onClick={() => {
                      setSearchOpen(false);
                      setOpen((k) => (k === section.key ? null : section.key));
                    }}
                    className={tileClass}
                  >
                    {section.icon}
                    <span className="leading-none">{section.label}</span>
                    {section.attention && (
                      <span className="absolute right-2 top-1.5 h-2 w-2 rounded-full bg-warning ring-2 ring-bg-surface" title="Items need attention" />
                    )}
                  </button>
                ) : (
                  <Link
                    href={section.href!}
                    onClick={() => { setMobileOpen(false); setOpen(null); setSearchOpen(false); }}
                    className={tileClass}
                  >
                    {section.icon}
                    <span className="leading-none">{section.label}</span>
                  </Link>
                )}

                {/* Flyout */}
                {hasItems && open === section.key && (
                  <div className="absolute left-full top-0 z-50 min-w-[210px] rounded-lg border border-border-default bg-bg-surface py-1.5 shadow-2xl">
                    <div className="px-3 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-text-tertiary">
                      {section.label}
                    </div>
                    {section.items!.map((item) => {
                      const subActive = pathname === item.href || pathname.startsWith(item.href + '/');
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          onClick={() => { setMobileOpen(false); setOpen(null); setSearchOpen(false); }}
                          className={`block px-3 py-1.5 text-sm transition-colors ${
                            subActive
                              ? 'bg-accent/10 text-accent'
                              : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                          }`}
                        >
                          {item.label}
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Sync status */}
        <Link
          href="/sync"
          onClick={() => { setMobileOpen(false); setOpen(null); setSearchOpen(false); }}
          title={lastSync ? formatSyncTime(lastSync) : 'No data synced yet'}
          className="flex h-12 w-full items-center justify-center border-t border-border-subtle"
        >
          <span className={`h-2.5 w-2.5 rounded-full ${lastSync ? 'bg-positive' : 'bg-warning'}`} />
        </Link>

        {/* Mobile close */}
        {mobileOpen && (
          <button
            onClick={() => { setMobileOpen(false); setOpen(null); setSearchOpen(false); }}
            className="absolute right-2 top-2 rounded-md p-1 text-text-tertiary hover:bg-bg-hover lg:hidden"
            aria-label="Close navigation"
          >
            <X size={18} />
          </button>
        )}
      </aside>
    </>
  );
}
