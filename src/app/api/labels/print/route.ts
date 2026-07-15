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
  labelMode: 'asin' | 'warehouse' | 'fnsku' | 'custom' | 'qr';
  size: '2x1' | '4x6' | '2.25x1.25';
  // qr fields
  qrValue?: string;    // encoded into the QR/barcode
  qrKind?: 'qrcode' | 'code128';
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

async function barcodePng(text: string, bcid: 'code128' | 'qrcode' = 'code128'): Promise<string> {
  try {
    const buf = await bwipjs.toBuffer({
      bcid,
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
// Barcode = ASIN. Customer-safe label modeled after InventoryLab's 2x1 hierarchy:
// large barcode, large human-readable ASIN, then condition/title detail.
// No MSKU, no cost, no supplier.

function renderAsin2x1(spec: LabelSpec, barcodeUrl: string): string {
  const asin  = esc(spec.asin || '');
  const rawTitle = trunc(spec.title || spec.asin, 58);
  const title = esc(rawTitle);
  const detail = esc(spec.condition && !rawTitle.toLowerCase().startsWith(`${spec.condition.toLowerCase()} -`)
    ? `${spec.condition} - ${rawTitle}`
    : rawTitle);
  const bin   = spec.showBin ? esc(spec.bin || '') : '';

  return `<div class="label label-2x1 asin-label-2x1" style="padding:3px 5px;">
  ${barcodeUrl
    ? `<img src="${barcodeUrl}" style="height:34pt;width:100%;object-fit:fill;display:block;flex-shrink:0;" alt="">`
    : '<div style="height:34pt;flex-shrink:0;"></div>'}
  <div style="font-size:11pt;line-height:1;font-family:monospace;color:#111;font-weight:800;text-align:center;letter-spacing:0.35px;margin-top:1px;white-space:nowrap;">${asin}</div>
  <div style="display:flex;align-items:stretch;gap:4px;margin-top:1px;min-height:17pt;overflow:hidden;">
    <div style="width:13pt;flex:0 0 13pt;border:1px solid #111;color:#111;font-size:5.5pt;font-weight:900;line-height:1;text-align:center;display:flex;flex-direction:column;justify-content:center;letter-spacing:0.4px;">
      <span>M</span><span>F</span><span>N</span>
    </div>
    <div style="min-width:0;display:flex;flex-direction:column;justify-content:center;line-height:1.08;overflow:hidden;">
      <div style="font-size:7.5pt;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${detail || title}</div>
      ${bin ? `<div style="font-size:6pt;color:#374151;font-family:monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px;">Bin ${bin}</div>` : ''}
    </div>
  </div>
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

function smallSizeClass(spec: LabelSpec): string {
  return spec.size === '2.25x1.25' ? 'label-225' : 'label-2x1';
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

  return `<div class="label ${smallSizeClass(spec)}">
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

  return `<div class="label ${smallSizeClass(spec)}">
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

  return `<div class="label ${smallSizeClass(spec)}" style="display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;">
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

// -- QR / scannable code label --

function renderQrSmall(spec: LabelSpec, barcodeUrl: string): string {
  const title = esc(trunc(spec.title, 40));
  const value = esc(trunc(spec.qrValue, 44));
  const isQr  = (spec.qrKind || 'qrcode') === 'qrcode';
  return `<div class="label ${smallSizeClass(spec)}" style="display:flex;align-items:center;gap:6px;">
  ${barcodeUrl ? `<img src="${barcodeUrl}" style="${isQr ? 'height:80%;aspect-ratio:1;' : 'height:40%;width:55%;'}object-fit:contain;display:block;flex-shrink:0;" alt="">` : ''}
  <div style="min-width:0;display:flex;flex-direction:column;justify-content:center;">
    ${title ? `<div style="font-size:8pt;font-weight:700;color:#111;line-height:1.15;overflow:hidden;">${title}</div>` : ''}
    ${value ? `<div style="font-size:5pt;font-family:monospace;color:#6b7280;margin-top:2px;word-break:break-all;overflow:hidden;">${value}</div>` : ''}
  </div>
</div>`;
}

function renderQr4x6(spec: LabelSpec, barcodeUrl: string): string {
  const title = esc(trunc(spec.title, 90));
  const value = esc(trunc(spec.qrValue, 120));
  return `<div class="label label-4x6" style="display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;">
  ${title ? `<div style="font-size:20pt;font-weight:800;color:#111;margin-bottom:12px;">${title}</div>` : ''}
  ${barcodeUrl ? `<img src="${barcodeUrl}" style="height:2.2in;object-fit:contain;display:block;" alt="">` : ''}
  ${value ? `<div style="font-size:9pt;font-family:monospace;color:#6b7280;margin-top:10px;word-break:break-all;max-width:92%;">${value}</div>` : ''}
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
      spec.labelMode === 'qr' ? spec.qrValue :
      spec.labelMode === 'custom' ? undefined :
      spec.asin;
    const bcid = spec.labelMode === 'qr' ? (spec.qrKind || 'qrcode') : 'code128';
    const cacheKey = barcodeText ? `${bcid}:${barcodeText}` : '';
    if (barcodeText && !barcodeCache.has(cacheKey)) {
      barcodeCache.set(cacheKey, await barcodePng(barcodeText, bcid));
    }
  }

  const firstSize  = specs[0]?.size || '2x1';
  const is4x6      = firstSize === '4x6';
  const is225      = firstSize === '2.25x1.25';
  const labelCount = specs.length;
  // Initial 4x6 orientation (?o=portrait|landscape, default landscape).
  const initialOrient = request.nextUrl.searchParams.get('o') === 'portrait' ? 'portrait' : 'landscape';

  const labelsHtml = specs.map(spec => {
    const barcodeText =
      spec.labelMode === 'fnsku' ? spec.fnsku :
      spec.labelMode === 'qr' ? spec.qrValue :
      spec.labelMode === 'custom' ? undefined :
      spec.asin;
    const bcid2 = spec.labelMode === 'qr' ? (spec.qrKind || 'qrcode') : 'code128';
    const barcodeUrl = barcodeText ? (barcodeCache.get(`${bcid2}:${barcodeText}`) || '') : '';

    switch (spec.labelMode) {
      case 'asin':
        return spec.size === '4x6' ? renderAsin4x6(spec, barcodeUrl) : renderAsin2x1(spec, barcodeUrl);
      case 'warehouse':
        return spec.size === '4x6' ? renderWarehouse4x6(spec, barcodeUrl) : renderWarehouse2x1(spec, barcodeUrl);
      case 'fnsku':
        return spec.size === '4x6' ? renderFnsku4x6(spec, barcodeUrl) : renderFnsku2x1(spec, barcodeUrl);
      case 'qr':
        return spec.size === '4x6' ? renderQr4x6(spec, barcodeUrl) : renderQrSmall(spec, barcodeUrl);
      case 'custom':
      default:
        return spec.size === '4x6' ? renderCustom4x6(spec) : renderCustom2x1(spec);
    }
  // 4x6 labels are wrapped in a .sheet that always prints as a 4in-wide ×
  // 6in-tall page — the ONLY media 4x6 thermal printers understand. Landscape
  // is achieved by rotating the label content inside the sheet, never by
  // asking the driver for 6x4 media (Offnova/Rollo-class drivers blank-feed
  // on that; see 85f0b74 for the previous incident in this family).
  }).map(h => is4x6 ? `<div class="sheet">${h}</div>` : h).join('\n');

  // Print-media rules for each 4x6 orientation. @page stays 4in 6in in BOTH —
  // orientation must never change the requested media size.
  const SHEET_LANDSCAPE_PRINT = '.sheet{display:block;position:relative;width:4in;height:6in;overflow:hidden;page-break-after:always;break-after:page;}.sheet:last-child{page-break-after:avoid;break-after:avoid;}.label-4x6{position:absolute;top:0;left:0;width:6in;height:4in;transform:rotate(90deg) translateY(-100%);transform-origin:top left;}';
  const SHEET_PORTRAIT_PRINT  = '.sheet{display:block;width:4in;height:6in;page-break-after:always;break-after:page;}.sheet:last-child{page-break-after:avoid;break-after:avoid;}.label-4x6{position:static;width:4in;height:6in;transform:none;}';

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
.sheet{display:contents;}
.label{background:white;overflow:hidden;border:1px dashed #9ca3af;display:flex;flex-direction:column;}
.label-2x1{width:2in;height:1in;padding:5px 6px;}
.label-225{width:2.25in;height:1.25in;padding:6px 7px;}
.label-4x6{width:${initialOrient === 'portrait' ? '4in;height:6in' : '6in;height:4in'};padding:10px 12px;}
.btn-orient{padding:7px 12px;background:white;color:#374151;border:none;font-size:13px;cursor:pointer;}
.btn-orient.active{background:#eff6ff;color:#1d4ed8;font-weight:600;}
@media print{
  ${is4x6 ? '@page{size:4in 6in;margin:0;}' : is225 ? '@page{size:2.25in 1.25in;margin:0;}' : '@page{size:2in 1in;margin:0;}'}
  body{background:white;}
  .toolbar{display:none;}
  .labels-wrap{padding:0;display:block;}
  ${is4x6
    ? `.label{border:none;}${initialOrient === 'portrait' ? SHEET_PORTRAIT_PRINT : SHEET_LANDSCAPE_PRINT}`
    : '.label{border:none;page-break-after:always;break-after:page;}.label:last-child{page-break-after:avoid;break-after:avoid;}'}
}
</style>
</head>
<body>
<div class="toolbar">
  <button class="btn-print" onclick="window.print()">Print</button>
  <button class="btn-close" onclick="window.close()">Close</button>
  ${is4x6 ? `<span style="display:inline-flex;border:1px solid #d1d5db;border-radius:6px;overflow:hidden;margin-left:4px;">
    <button id="o-portrait" class="btn-orient" onclick="setOrient('portrait')">Portrait</button>
    <button id="o-landscape" class="btn-orient" onclick="setOrient('landscape')">Landscape</button>
  </span>` : ''}
  <span class="toolbar-info">${labelCount} label${labelCount !== 1 ? 's' : ''} &middot; ${firstSize}</span>
</div>
<div class="labels-wrap">
${labelsHtml}
</div>
${is4x6 ? `<style id="orient"></style>
<script>
  // Both variants keep @page at 4in 6in (the printer's native media) —
  // orientation only rotates the label content. The static head stylesheet
  // already carries the initial orientation, so printing works with no JS.
  var ORIENT={
    portrait:'.label-4x6{width:4in;height:6in;} @media print{${SHEET_PORTRAIT_PRINT}}',
    landscape:'.label-4x6{width:6in;height:4in;} @media print{${SHEET_LANDSCAPE_PRINT}}'
  };
  function setOrient(m){document.getElementById('orient').textContent=ORIENT[m];var p=document.getElementById('o-portrait'),l=document.getElementById('o-landscape');p.classList.toggle('active',m==='portrait');l.classList.toggle('active',m==='landscape');}
  setOrient('${initialOrient}');
</script>` : ''}
</body>
</html>`;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}
