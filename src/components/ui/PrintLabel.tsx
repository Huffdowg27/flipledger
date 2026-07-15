'use client';

import { Printer } from 'lucide-react';

/**
 * Inline label printing — surfaces the existing /api/labels/print renderer
 * wherever the item is, so printing never requires navigating to /labels.
 *
 * `openLabelPrint` mirrors the encoding used by /labels and the batch print
 * path: base64(JSON) in the `d` query param, URI-encoded because raw '+'
 * decodes to a space server-side and corrupts the payload.
 */

export interface PrintLabelSpec {
  labelMode: 'asin' | 'warehouse' | 'fnsku' | 'custom';
  size: '2x1' | '4x6';
  title?: string;
  asin?: string;
  fnsku?: string;
  sku?: string;
  bin?: string;
  condition?: string;
  priceCents?: number;
  showPrice?: boolean;
  showBin?: boolean;
  subtitle?: string;
  notes?: string;
}

export function openLabelPrint(specs: PrintLabelSpec[]) {
  if (typeof window === 'undefined' || specs.length === 0) return;
  const json = JSON.stringify(specs);
  // btoa requires latin-1 — escape unicode first (same as /labels page).
  const utf8 = unescape(encodeURIComponent(json));
  const encoded = encodeURIComponent(window.btoa(utf8));
  window.open(`/api/labels/print?d=${encoded}`, '_blank', 'noopener');
}

/** True FNSKUs start with X00 — ASINs pasted into fnsku fields must not print as FNSKU barcodes. */
function realFnsku(value: string | null | undefined): string {
  const fnsku = String(value || '').trim().toUpperCase();
  return /^X00[A-Z0-9]+$/.test(fnsku) ? fnsku : '';
}

export interface PrintableItem {
  title?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  sku?: string | null;
  bin?: string | null;
  condition?: string | null;
}

/**
 * One-click printer icon for a row. Chooses the safest label mode
 * automatically unless `mode` is forced:
 *   - real FNSKU present → fnsku label (prep/FBA)
 *   - else ASIN present  → warehouse label (internal: barcode=ASIN + MSKU/bin)
 *   - else               → custom text label
 */
export function PrintLabelIcon({
  item,
  qty = 1,
  mode,
  size = '2x1',
  className = '',
}: {
  item: PrintableItem;
  qty?: number;
  mode?: PrintLabelSpec['labelMode'];
  size?: PrintLabelSpec['size'];
  className?: string;
}) {
  const fnsku = realFnsku(item.fnsku);
  const resolvedMode: PrintLabelSpec['labelMode'] =
    mode ?? (fnsku ? 'fnsku' : (item.asin ?? '').trim() ? 'warehouse' : 'custom');

  function print(event: React.MouseEvent) {
    event.stopPropagation();
    event.preventDefault();
    const copies = Math.max(1, Math.min(200, Math.floor(qty) || 1));
    const spec: PrintLabelSpec = {
      labelMode: resolvedMode,
      size,
      title: item.title ?? undefined,
      asin: (item.asin ?? '').trim() || undefined,
      fnsku: fnsku || undefined,
      sku: (item.sku ?? '').trim() || undefined,
      bin: (item.bin ?? '').trim() || undefined,
      condition: (item.condition ?? '').trim() || undefined,
      showBin: !!(item.bin ?? '').trim(),
      subtitle: resolvedMode === 'custom' ? (item.sku ?? item.asin ?? '') || undefined : undefined,
    };
    openLabelPrint(Array.from({ length: copies }, () => spec));
  }

  const label = resolvedMode === 'fnsku' ? 'FNSKU label' : resolvedMode === 'warehouse' ? 'warehouse label' : 'label';
  return (
    <button
      type="button"
      onClick={print}
      title={`Print ${qty > 1 ? `${qty}× ` : ''}${label}`}
      className={`shrink-0 text-text-tertiary/50 transition-colors hover:text-accent ${className}`}
    >
      <Printer size={11} />
    </button>
  );
}
