import { NextRequest } from 'next/server';
import bwipjs from 'bwip-js/node';

/**
 * Label modes:
 *   asin      — Customer-safe. Barcode = ASIN. No MSKU, cost, supplier, or dates.
 *   warehouse — Internal only. Barcode = ASIN. May include MSKU, bin, optional price.
 *   fnsku     — Barcode = real FNSKU. No MSKU. Only usable when fnsku is present.
 *   custom    — Free-text label.
 */
export interface LabelSpec {
  labelMode: 'asin' | 'warehouse' | 'fnsku' | 'custom';
  size: '2x1' | '4x6';
  // product fields
  title?: string;
  asin?: string;
  fnsku?: string;
  sku?: string;        // MSKU — only rendered in warehouse mode
  bin?: string;
  condition?: string;
  priceCents?: number;
  showPrice?: boolean; // warehouse mode only
  showBin?: boolean;   // asin mode: optional bin for picking reference
  // custom fields
  subtitle?: string;
  notes?: string;
}

async function barcodePng(text: string): Promise<string> {
  try {
    const buf = await bwipjs.toBuffer({
      bcid: 'code128',
      text,
      scale: 3,
      height: 8,
      includetext: false,
      backgroundcolor: 'FFFFFF',
    });
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

function esc(s: string | null | undefined): string {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function trunc(s: string | null | undefined, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function realFnsku(value: string | null | undefined): string {
  const fnsku = String(value || '').trim().toUpperCase();
  return /^X00[A-Z0-9]+$/.test(fnsku) ? fnsku : '';
}

// -- ASIN Label (Customer Safe) --
// Barcode = ASIN. Shows: ASIN + condition at top, barcode middle, title at bottom.
// No MSKU, no cost, no supplier.

function renderAsin2x1(spec: LabelSpec, barcodeUrl: string): string {
  const asin  = esc(spec.asin || '');
  const cond  = esc(spec.condition || '');
  const title = esc(trunc(spec.title || spec.asin, 52));

  return `<div class="label label-2x1">
  <div style="font-size:6.5pt;line-height:1.2;display:flex;align-items:center;gap:4px;margin-bottom:1px;overflow:hidden;white-space:nowrap;">
    <span style="font-family:monospace;color:#111;font-weight:600;">${asin}</span>
    ${cond ? `<span style="color:#6b7280;">|</span><span style="color:#374151;">${cond}</span>` : ''}
  </div>
  ${barcodeUrl
    ? `<img src="${barcodeUrl}" style="height:28pt;width:100%;object-fit:contain;object-position:left;display:block;flex-shrink:0;" alt="">`
    : '<div style="height:28pt;flex-shrink:0;"></div>'}
  <div style="font-size:5pt;color:#4b5563;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">${title}</div>
</div>`;
}

function renderAsin4x6(spec: LabelSpec, barcodeUrl: string): string {
  const title = esc(trunc(spec.title || spec.asin, 100));
  const asin  = esc(spec.asin || '');
  const cond  = esc(spec.condition || '');
  const bin   = spec.showBin ? esc(spec.bin || '') : '';

  return `<div class="label label-4x6">
  <div style="font-size:13pt;font-weight:700;line-height:1.3;margin-bottom:8px;">${title}</div>
  ${barcodeUrl
    ? `<img src="${barcodeUrl}" style="height:52pt;width:82%;object-fit:contain;object-position:left;display:block;margin-bottom:3px;" alt="">`
    : ''}
  <div style="font-size:9pt;font-family:monospace;color:#374151;margin-bottom:6px;">${asin}</div>
  <div style="font-size:9pt;color:#374151;">${cond}</div>
  ${bin
    ? `<div style="margin-top:auto;padding-top:10px;border-top:1px solid #e5e7eb;">
         <span style="background:#eff6ff;color:#1d4ed8;padding:4px 12px;border-radius:5px;font-size:11pt;font-weight:700;font-family:monospace;">${bin}</span>
       </div>`
    : ''}
</div>`;
}

// -- Internal Warehouse Label --
// Barcode = ASIN. Shows: ASIN + condition at top, barcode middle, MSKU + bin + price at bottom.

function renderWarehouse2x1(spec: LabelSpec, barcodeUrl: string): string {
  const asin  = esc(spec.asin || '');
  const cond  = esc(spec.condition || '');
  const sku   = esc(trunc(spec.sku, 32));
  const bin   = esc(spec.bin || '');
  const price = spec.showPrice && spec.priceCents ? `$${(spec.priceCents / 100).toFixed(2)}` : '';
  const title = esc(trunc(spec.title || spec.asin, 52));

  return `<div class="label label-2x1">
  <div style="font-size:6pt;line-height:1.2;display:flex;align-items:center;gap:4px;margin-bottom:1px;overflow:hidden;white-space:nowrap;">
    <span style="font-family:monospace;color:#111;font-weight:600;">${asin}</span>
    ${cond ? `<span style="color:#6b7280;">|</span><span style="color:#374151;">${cond}</span>` : ''}
  </div>
  ${barcodeUrl
    ? `<img src="${barcodeUrl}" style="height:22pt;width:100%;object-fit:contain;object-position:left;display:block;flex-shrink:0;" alt="">`
    : '<div style="height:22pt;flex-shrink:0;"></div>'}
  <div style="font-size:4.5pt;font-family:monospace;color:#374151;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">${sku || title}</div>
  <div style="font-size:4.5pt;display:flex;align-items:center;gap:3px;margin-top:1px;overflow:hidden;white-space:nowrap;">
    ${bin   ? `<span style="background:#eff6ff;color:#1d4ed8;padding:0 3px;border-radius:2px;font-family:monospace;font-weight:700;">${bin}</span>` : ''}
    ${price ? `<span style="margin-left:auto;font-weight:600;color:#111;">${price}</span>` : ''}
  </div>
</div>`;
}

function renderWarehouse4x6(spec: LabelSpec, barcodeUrl: string): string {
  const title = esc(trunc(spec.title || spec.asin, 100));
  const asin  = esc(spec.asin || '');
  const sku   = esc(spec.sku || '');
  const bin   = esc(spec.bin || '');
  const cond  = esc(spec.condition || '');
  const price = spec.showPrice && spec.priceCents ? `$${(spec.priceCents / 100).toFixed(2)}` : '';

  return `<div class="label label-4x6">
  <div style="font-size:13pt;font-weight:700;line-height:1.3;margin-bottom:7px;">${title}</div>
  <div style="font-size:8pt;color:#6b7280;margin-bottom:3px;">ASIN: <span style="font-family:monospace;color:#111;">${asin}</span></div>
  ${sku ? `<div style="font-size:7pt;color:#6b7280;margin-bottom:9px;word-break:break-all;">MSKU: <span style="font-family:monospace;color:#111;">${sku}</span></div>` : ''}
  ${barcodeUrl
    ? `<img src="${barcodeUrl}" style="height:50pt;width:82%;object-fit:contain;object-position:left;display:block;margin-bottom:2px;" alt="">`
    : ''}
  ${asin ? `<div style="font-size:7.5pt;font-family:monospace;color:#374151;margin-bottom:12px;">${asin}</div>` : ''}
  <div style="border-top:1px solid #e5e7eb;padding-top:9px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:auto;">
    ${bin   ? `<span style="background:#eff6ff;color:#1d4ed8;padding:4px 10px;border-radius:5px;font-size:11pt;font-weight:700;font-family:monospace;">${bin}</span>` : ''}
    ${cond  ? `<span style="font-size:9pt;color:#374151;">${cond}</span>` : ''}
    ${price ? `<span style="margin-left:auto;font-size:10pt;font-weight:600;color:#111;">${price}</span>` : ''}
  </div>
</div>`;
}

// -- FNSKU Label --
// Barcode = FNSKU. Shows: FNSKU + condition at top, barcode middle, title at bottom.
// No MSKU, no cost.

function renderFnsku2x1(spec: LabelSpec, barcodeUrl: string): string {
  const fnsku = esc(spec.fnsku || '');
  const cond  = esc(spec.condition || '');
  const title = esc(trunc(spec.title || spec.asin, 52));

  return `<div class="label label-2x1">
  <div style="font-size:6.5pt;line-height:1.2;display:flex;align-items:center;gap:4px;margin-bottom:1px;overflow:hidden;white-space:nowrap;">
    <span style="font-family:monospace;color:#111;font-weight:600;">${fnsku}</span>
    ${cond ? `<span style="color:#6b7280;">|</span><span style="color:#374151;">${cond}</span>` : ''}
  </div>
  ${barcodeUrl
    ? `<img src="${barcodeUrl}" style="height:28pt;width:100%;object-fit:contain;object-position:left;display:block;flex-shrink:0;" alt="">`
    : '<div style="height:28pt;flex-shrink:0;"></div>'}
  <div style="font-size:5pt;color:#4b5563;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">${title}</div>
</div>`;
}

function renderFnsku4x6(spec: LabelSpec, barcodeUrl: string): string {
  const title = esc(trunc(spec.title || spec.asin, 100));
  const fnsku = esc(spec.fnsku || '');
  const cond  = esc(spec.condition || '');

  return `<div class="label label-4x6">
  <div style="font-size:13pt;font-weight:700;line-height:1.3;margin-bottom:8px;">${title}</div>
  ${barcodeUrl
    ? `<img src="${barcodeUrl}" style="height:52pt;width:82%;object-fit:contain;object-position:left;display:block;margin-bottom:3px;" alt="">`
    : ''}
  <div style="font-size:9pt;font-family:monospace;color:#374151;margin-bottom:6px;">${fnsku}</div>
  <div style="font-size:9pt;color:#374151;">${cond}</div>
</div>`;
}

// -- Custom Label --

function renderCustom2x1(spec: LabelSpec): string {
  const title    = esc(spec.title || '');
  const subtitle = esc(spec.subtitle || '');
  const notes    = esc(spec.notes || '');

  return `<div class="label label-2x1" style="display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;">
  ${title    ? `<div style="font-size:18pt;font-weight:800;color:#111;line-height:1.1;">${title}</div>` : ''}
  ${subtitle ? `<div style="font-size:8pt;color:#374151;margin-top:2px;">${subtitle}</div>` : ''}
  ${notes    ? `<div style="font-size:6pt;color:#6b7280;margin-top:2px;">${notes}</div>` : ''}
</div>`;
}

function renderCustom4x6(spec: LabelSpec): string {
  const title    = esc(spec.title || '');
  const subtitle = esc(spec.subtitle || '');
  const notes    = esc(spec.notes || '');
  const bin      = esc(spec.bin || '');
  const sku      = esc(spec.sku || '');
  const asin     = esc(spec.asin || '');

  return `<div class="label label-4x6" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
  ${title    ? `<div style="font-size:52pt;font-weight:800;color:#111;line-height:1;margin-bottom:10px;">${title}</div>` : ''}
  ${subtitle ? `<div style="font-size:16pt;color:#374151;margin-bottom:8px;">${subtitle}</div>` : ''}
  ${notes    ? `<div style="font-size:10pt;color:#6b7280;max-width:90%;margin-bottom:8px;">${notes}</div>` : ''}
  ${bin      ? `<div style="margin-top:12px;background:#eff6ff;color:#1d4ed8;padding:5px 18px;border-radius:6px;font-size:14pt;font-weight:700;font-family:monospace;">${bin}</div>` : ''}
  ${sku      ? `<div style="font-size:8pt;font-family:monospace;color:#4b5563;margin-top:10px;">SKU: ${sku}</div>` : ''}
  ${asin     ? `<div style="font-size:8pt;font-family:monospace;color:#4b5563;">ASIN: ${asin}</div>` : ''}
</div>`;
}

// -- Route handler --

export async function GET(request: NextRequest) {
  const d = request.nextUrl.searchParams.get('d');
  if (!d) {
    return new Response('<html><body style="font-family:sans-serif;padding:2rem;">No label data provided.</body></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  let specs: LabelSpec[];
  try {
    specs = JSON.parse(Buffer.from(d, 'base64').toString('utf-8'));
    if (!Array.isArray(specs) || specs.length === 0) throw new Error('empty');
    specs = specs.flatMap(spec => {
      if (spec.labelMode !== 'fnsku') return [spec];
      const fnsku = realFnsku(spec.fnsku);
      return fnsku ? [{ ...spec, fnsku }] : [];
    });
    if (specs.length === 0) throw new Error('empty');
  } catch {
    return new Response('<html><body style="font-family:sans-serif;padding:2rem;">Invalid label data.</body></html>', {
      headers: { 'Content-Type': 'text/html' },
    });
  }

  // Pre-generate barcodes keyed by barcode text (ASIN or FNSKU depending on mode)
  const barcodeCache = new Map<string, string>();
  for (const spec of specs) {
    const barcodeText =
      spec.labelMode === 'fnsku' ? spec.fnsku :
      spec.labelMode === 'custom' ? undefined :
      spec.asin;
    if (barcodeText && !barcodeCache.has(barcodeText)) {
      barcodeCache.set(barcodeText, await barcodePng(barcodeText));
    }
  }

  const firstSize  = specs[0]?.size || '2x1';
  const pageSize   = firstSize === '4x6' ? '4in 6in' : '2in 1in';
  const labelCount = specs.length;

  const labelsHtml = specs.map(spec => {
    const barcodeText =
      spec.labelMode === 'fnsku' ? spec.fnsku :
      spec.labelMode === 'custom' ? undefined :
      spec.asin;
    const barcodeUrl = barcodeText ? (barcodeCache.get(barcodeText) || '') : '';

    switch (spec.labelMode) {
      case 'asin':
        return spec.size === '4x6' ? renderAsin4x6(spec, barcodeUrl) : renderAsin2x1(spec, barcodeUrl);
      case 'warehouse':
        return spec.size === '4x6' ? renderWarehouse4x6(spec, barcodeUrl) : renderWarehouse2x1(spec, barcodeUrl);
      case 'fnsku':
        return spec.size === '4x6' ? renderFnsku4x6(spec, barcodeUrl) : renderFnsku2x1(spec, barcodeUrl);
      case 'custom':
      default:
        return spec.size === '4x6' ? renderCustom4x6(spec) : renderCustom2x1(spec);
    }
  }).join('\n');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Labels — FlipLedger</title>
<style>
*,*::before,*::after{box-sizing:border-box;}
body{margin:0;padding:0;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f3f4f6;}
.toolbar{position:sticky;top:0;background:white;border-bottom:1px solid #e5e7eb;padding:10px 16px;display:flex;align-items:center;gap:10px;z-index:10;}
.btn-print{padding:7px 18px;background:#2563eb;color:white;border:none;border-radius:6px;font-size:14px;cursor:pointer;font-weight:500;}
.btn-print:hover{background:#1d4ed8;}
.btn-close{padding:7px 14px;background:white;color:#374151;border:1px solid #d1d5db;border-radius:6px;font-size:14px;cursor:pointer;}
.btn-close:hover{background:#f9fafb;}
.toolbar-info{margin-left:auto;font-size:13px;color:#6b7280;}
.labels-wrap{padding:24px;display:flex;flex-wrap:wrap;gap:16px;}
.label{background:white;overflow:hidden;border:1px dashed #9ca3af;display:flex;flex-direction:column;}
.label-2x1{width:2in;height:1in;padding:5px 6px;}
.label-4x6{width:4in;height:6in;padding:10px 12px;}
@media print{
  @page{size:${pageSize};margin:0;}
  body{background:white;}
  .toolbar{display:none;}
  .labels-wrap{padding:0;display:block;}
  .label{border:none;page-break-after:always;break-after:page;}
  .label:last-child{page-break-after:avoid;break-after:avoid;}
}
</style>
</head>
<body>
<div class="toolbar">
  <button class="btn-print" onclick="window.print()">Print</button>
  <button class="btn-close" onclick="window.close()">Close</button>
  <span class="toolbar-info">${labelCount} label${labelCount !== 1 ? 's' : ''} &middot; ${firstSize}</span>
</div>
<div class="labels-wrap">
${labelsHtml}
</div>
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
