'use client';

import Link from 'next/link';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { useState } from 'react';

const AMAZON_ORDER_ID = /^\d{3}-\d{7}-\d{7}$/;
// eBay purchase order numbers (buyer side), e.g. 05-14755-28725
const EBAY_PURCHASE_ID = /^\d{2}-\d{5}-\d{5}$/;

function amazonAsinUrl(value: string): string {
  return `https://www.amazon.com/dp/${encodeURIComponent(value)}`;
}

function inventorySkuHref(value: string): string {
  return `/inventory?search=${encodeURIComponent(value)}`;
}

export function orderExternalUrl(orderId: string | null | undefined, marketplace?: string | null): string | null {
  const value = (orderId ?? '').trim();
  const market = (marketplace ?? '').trim().toLowerCase();
  if (!value) return null;
  if (market === 'amazon' && AMAZON_ORDER_ID.test(value)) {
    return `https://sellercentral.amazon.com/orders-v3/order/${encodeURIComponent(value)}`;
  }
  if (market === 'ebay') {
    return `https://www.ebay.com/mesh/ord/details?orderid=${encodeURIComponent(value)}`;
  }
  // No marketplace context, but the value is shaped like an eBay PURCHASE
  // order number (incoming rows: we're the buyer) — deep-link to My eBay
  // purchases with the order pre-searched.
  if (EBAY_PURCHASE_ID.test(value)) {
    return `https://www.ebay.com/mye/myebay/purchase?q=${encodeURIComponent(value)}&pg=purchase&type=v2&mp=purchase-search-module-v2&page=1`;
  }
  return null;
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);

  async function copy(event: React.MouseEvent) {
    event.stopPropagation();
    event.preventDefault();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can be unavailable in locked-down browser contexts.
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      title={`Copy ${label}: ${value}`}
      className="shrink-0 text-text-tertiary/50 transition-colors hover:text-text-tertiary"
    >
      {copied ? <Check size={11} className="text-positive" /> : <Copy size={11} />}
    </button>
  );
}

export function IdentifierChip({
  label,
  value,
  kind,
  className = '',
}: {
  label: string;
  value: string | null | undefined;
  kind: 'asin' | 'sku' | 'text';
  className?: string;
}) {
  const text = (value ?? '').trim();
  if (!text) return null;
  const href = kind === 'asin' ? amazonAsinUrl(text) : kind === 'sku' ? inventorySkuHref(text) : null;
  const external = kind === 'asin';

  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      <span className="shrink-0 text-text-tertiary/60 uppercase tracking-wide">{label}</span>
      {href
        ? external
          ? (
            <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="truncate text-accent hover:underline" title={`Open ${label}: ${text}`}>
              {text}
            </a>
          )
          : (
            <Link href={href} onClick={(e) => e.stopPropagation()} className="truncate text-accent hover:underline" title={`Find ${label}: ${text}`}>
              {text}
            </Link>
          )
        : <span className="truncate text-text-secondary" title={text}>{text}</span>}
      <CopyButton value={text} label={label} />
    </span>
  );
}

export function OrderReference({
  orderId,
  marketplace,
  prefix = '',
  className = '',
}: {
  orderId: string | null | undefined;
  marketplace?: string | null;
  prefix?: string;
  className?: string;
}) {
  const value = (orderId ?? '').trim();
  if (!value) return null;
  const href = orderExternalUrl(value, marketplace);
  const display = `${prefix}${value}`;

  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex min-w-0 items-center gap-1 truncate text-accent hover:underline" title={`Open order: ${value}`}>
          <span className="truncate">{display}</span>
          <ExternalLink size={12} className="shrink-0 opacity-70" />
        </a>
      ) : (
        <span className="truncate text-accent" title={value}>{display}</span>
      )}
      <CopyButton value={value} label="order ID" />
    </span>
  );
}
