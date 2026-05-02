'use client';

import { usePathname } from 'next/navigation';
import Link from 'next/link';
import {
  LayoutDashboard,
  TrendingUp,
  Receipt,
  DollarSign,
  Package,
  ShoppingBag,
  PackageMinus,
  BarChart3,
  Tags,
  Store,
  ShoppingCart,
  Undo2,
  HandCoins,
  Wallet,
  Truck,
  CreditCard,
  FileText,
  Settings,
  ChevronLeft,
  Menu,
  RefreshCw,
  ScanBarcode,
} from 'lucide-react';
import { useState, useEffect } from 'react';
import GlobalSearch from '@/components/ui/GlobalSearch';

interface NavItem {
  label: string;
  href: string;
  icon: React.ReactNode;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

function formatSyncTime(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'Synced just now';
  if (mins < 60) return `Synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${new Date(isoDate).toLocaleDateString()}`;
}

const navSections: NavSection[] = [
  {
    title: '',
    items: [
      { label: 'Dashboard', href: '/', icon: <LayoutDashboard size={18} /> },
      { label: 'Products & COGS', href: '/products', icon: <ShoppingBag size={18} /> },
    ],
  },
  {
    title: 'LISTING',
    items: [
      { label: 'Batches', href: '/list', icon: <ScanBarcode size={18} /> },
    ],
  },
  {
    title: 'ANALYZE',
    items: [
      { label: 'Profit & Loss', href: '/analyze/profitloss', icon: <TrendingUp size={18} /> },
      { label: 'Sales Tax', href: '/analyze/salestax', icon: <Receipt size={18} /> },
      { label: 'Removals', href: '/analyze/removals', icon: <PackageMinus size={18} /> },
      { label: 'Inventory Valuation', href: '/analyze/inventory-valuation', icon: <Package size={18} /> },
      { label: 'ASIN Profitability', href: '/analyze/asin-profitability', icon: <BarChart3 size={18} /> },
      { label: 'SKU Profitability', href: '/analyze/sku-profitability', icon: <Tags size={18} /> },
      { label: 'Supplier Profitability', href: '/analyze/supplier-profitability', icon: <Store size={18} /> },
    ],
  },
  {
    title: 'TAX CENTER',
    items: [
      { label: 'Tax Report', href: '/tax-report', icon: <FileText size={18} /> },
    ],
  },
  {
    title: 'BOOKKEEPING',
    items: [
      { label: 'FBA Sales', href: '/bookkeep/fba-sales', icon: <ShoppingCart size={18} /> },
      { label: 'WFS Sales', href: '/bookkeep/wfs-sales', icon: <ShoppingCart size={18} /> },
      { label: 'Merchant Sales', href: '/bookkeep/merchant-sales', icon: <ShoppingCart size={18} /> },
      { label: 'eBay Sales', href: '/bookkeep/ebay-sales', icon: <ShoppingCart size={18} /> },
      { label: 'Refunds', href: '/bookkeep/refunds', icon: <Undo2 size={18} /> },
      { label: 'Reimbursements', href: '/bookkeep/reimbursements', icon: <HandCoins size={18} /> },
      { label: 'Claims to File', href: '/bookkeep/claims-to-file', icon: <HandCoins size={18} /> },
      { label: 'Reimbursement Re-Evaluations', href: '/bookkeep/reimbursement-reevaluations', icon: <HandCoins size={18} /> },
      { label: 'Amazon Disputes', href: '/bookkeep/amazon-disputes', icon: <HandCoins size={18} /> },
      { label: 'Walmart Disputes', href: '/bookkeep/walmart-disputes', icon: <HandCoins size={18} /> },
      { label: 'Inbound Shipping', href: '/bookkeep/inbound-shipping', icon: <Truck size={18} /> },
      { label: 'Other Expenses', href: '/bookkeep/other-expenses', icon: <CreditCard size={18} /> },
    ],
  },
];

export default function Sidebar() {
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);

  // Fetch last sync time and refresh periodically
  const fetchLastSync = () => {
    fetch('/api/data/settings')
      .then(r => r.json())
      .then(data => {
        if (data.settings?.lastSync) setLastSync(data.settings.lastSync);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchLastSync();
    // Initialize auto-sync
    fetch('/api/sync/auto').catch(() => {});
    // Poll for sync updates every 60 seconds
    const interval = setInterval(fetchLastSync, 60000);
    return () => clearInterval(interval);
  }, []);

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
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`
          fixed top-0 left-0 z-50 h-screen bg-bg-surface border-r border-border-subtle
          flex flex-col transition-all duration-200 ease-in-out
          ${collapsed ? 'w-16' : 'w-60'}
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
          lg:translate-x-0 lg:relative lg:z-auto
        `}
      >
        {/* Logo */}
        <div className="flex items-center justify-between h-14 px-4 border-b border-border-subtle shrink-0">
          {!collapsed && (
            <Link href="/" className="text-lg font-semibold text-text-primary tracking-tight">
              FlipLedger
            </Link>
          )}
          <button
            onClick={() => {
              setCollapsed(!collapsed);
              setMobileOpen(false);
            }}
            className="p-1 rounded-md hover:bg-bg-hover transition-colors"
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            <ChevronLeft
              size={18}
              className={`text-text-tertiary transition-transform ${collapsed ? 'rotate-180' : ''}`}
            />
          </button>
        </div>

        {/* Search */}
        <div className="px-2 pt-3 pb-1 shrink-0">
          <GlobalSearch collapsed={collapsed} />
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {navSections.map((section) => (
            <div key={section.title || 'main'} className="mb-3">
              {section.title && !collapsed && (
                <div className="px-3 mb-1.5 text-[11px] font-medium tracking-widest text-text-tertiary uppercase">
                  {section.title}
                </div>
              )}
              {section.title && collapsed && (
                <div className="w-full h-px bg-border-subtle my-2" />
              )}
              {section.items.map((item) => {
                const isActive = pathname === item.href;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    title={collapsed ? item.label : undefined}
                    className={`
                      flex items-center gap-2.5 h-8 px-3 rounded-md text-sm transition-colors
                      ${collapsed ? 'justify-center px-0' : ''}
                      ${isActive
                        ? 'bg-bg-active text-text-primary border-l-2 border-accent'
                        : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
                      }
                    `}
                  >
                    <span className={`shrink-0 ${isActive ? 'text-accent' : 'text-text-tertiary'}`}>
                      {item.icon}
                    </span>
                    {!collapsed && <span className="truncate">{item.label}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Footer */}
        <div className="shrink-0 px-3 py-3 border-t border-border-subtle">
          <div className="flex items-center gap-2 text-xs text-text-tertiary mb-2">
            <span className={`w-2 h-2 rounded-full ${lastSync ? 'bg-positive' : 'bg-warning'}`} />
            {!collapsed && <span>{lastSync ? formatSyncTime(lastSync) : 'No data synced yet'}</span>}
          </div>
          <Link
            href="/settings"
            className={`
              flex items-center gap-2.5 h-8 px-3 rounded-md text-sm transition-colors
              ${collapsed ? 'justify-center px-0' : ''}
              ${pathname === '/settings'
                ? 'bg-bg-active text-text-primary'
                : 'text-text-secondary hover:bg-bg-hover hover:text-text-primary'
              }
            `}
          >
            <Settings size={18} className="text-text-tertiary shrink-0" />
            {!collapsed && <span>Settings</span>}
          </Link>
        </div>
      </aside>
    </>
  );
}
