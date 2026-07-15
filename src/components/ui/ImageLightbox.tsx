'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';

export interface LightboxData {
  src: string;
  title: string;
  asin: string | null;
  sku: string | null;
}

function sellerCentralSkuUrl(sku: string | null | undefined): string | null {
  if (!sku || !sku.trim()) return null;
  return `https://sellercentral.amazon.com/myinventory/inventory?searchField=all&searchTerm=${encodeURIComponent(sku.trim())}`;
}

// Full resolution — strip Amazon's "._SX300_." style size suffix.
function fullRes(src: string): string {
  return src.replace(/\._[A-Z0-9,]+_\.(jpg|jpeg|png)/i, '.$1');
}

/**
 * Shared product-image lightbox — the one uniform image pop-out used across
 * FlipLedger (inventory, MFN, incoming, …). Click the backdrop or press Esc to
 * close. Controlled: the parent holds the `data` state and clears it on close.
 */
export function ImageLightbox({ data, onClose }: { data: LightboxData | null; onClose: () => void }) {
  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, onClose]);

  if (!data) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4" onClick={onClose}>
      <div className="relative flex flex-col overflow-hidden rounded-xl bg-white shadow-2xl max-w-[92vw] max-h-[92vh]" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start gap-3 border-b border-border-subtle bg-bg-elevated px-5 py-3.5">
          <div className="min-w-0">
            <div className="line-clamp-2 text-base font-semibold leading-snug text-text-primary">{data.title}</div>
            <div className="mt-1 flex gap-4 text-[11px] font-mono text-text-tertiary">
              {data.asin && <a href={`https://www.amazon.com/dp/${data.asin}`} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">ASIN {data.asin}</a>}
              {data.sku && (sellerCentralSkuUrl(data.sku)
                ? <a href={sellerCentralSkuUrl(data.sku)!} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">MSKU {data.sku}</a>
                : <span>MSKU {data.sku}</span>)}
            </div>
          </div>
          <button onClick={onClose} className="ml-auto flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-tertiary hover:bg-bg-hover hover:text-text-primary" title="Close (Esc)">
            <X size={20} />
          </button>
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={fullRes(data.src)} alt={data.title} className="h-[80vh] w-auto max-w-[92vw] bg-white object-contain" />
      </div>
    </div>
  );
}
