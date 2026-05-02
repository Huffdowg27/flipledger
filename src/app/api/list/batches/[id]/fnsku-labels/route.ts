/**
 * GET /api/list/batches/[id]/fnsku-labels
 *
 * Generate FNSKU labels for every unit in the batch, CLIENT-SIDE — no
 * shipment ID required. Works as soon as the batch is in 'ready' state
 * (after Send to Amazon assigns FNSKUs). Lets the user print labels BEFORE
 * boxing/packing instead of having to confirm placement first and then go
 * back and label a packed box.
 *
 * Query params:
 *   action  — 'download' (default) returns the PDF; 'print' spools to Rollo
 *   mode    — 'per-sku' (default, one label per unique SKU — set copy count
 *             at the Rollo software when printing 12 of one item) OR
 *             'per-unit' (one PDF page per individual unit, Rollo prints once
 *             per page — useful when you want labels pre-counted, no Rollo
 *             dialog needed)
 *   itemId  — optional, filters to a single batch item. Use for the per-row
 *             "Print FNSKU" button on each item.
 *   copies  — optional integer override. When set, generates exactly N
 *             pre-counted labels regardless of mode. Useful for "print 1
 *             replacement" or "print 6 of the 12" partial cases. Forces
 *             per-unit semantics so the Rollo just spools N labels with no
 *             dialog. Requires itemId — only meaningful for a single SKU.
 *
 * For each item in the batch:
 *   1. GET /listings/2021-08-01/items/{sellerId}/{sku} to fetch fnSku
 *      (we don't store it locally yet; fetched live, ~5 SP-API calls)
 *   2. Generate Code 128 barcode + label layout per unit (one page per unit)
 *   3. Combine into single PDF
 *
 * Output: 2"×1" thermal labels, one page per individual unit, ready to send
 * to a Rollo printer or download for any thermal printer.
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import { getListing, getSellerId } from '@/lib/sp-api/listingsItems';
import { generateFnskuLabelPdf, type LabelInput } from '@/lib/fnsku-labels';
import { printPdfBuffer, listAvailablePrinters } from '@/lib/print';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

function getAmazonCredentials(db: Database.Database): SPAPICredentials | null {
  const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  if (!settings.clientId || !settings.clientSecret || !settings.refreshToken) return null;
  return {
    clientId: settings.clientId,
    clientSecret: settings.clientSecret,
    refreshToken: settings.refreshToken,
    marketplaceId: settings.marketplaceId || 'ATVPDKIKX0DER',
  };
}

function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || null;
}

const CONDITION_LABELS: Record<string, string> = {
  NewItem: 'New',
  UsedLikeNew: 'Used - Like New',
  UsedVeryGood: 'Used - Very Good',
  UsedGood: 'Used - Good',
  UsedAcceptable: 'Used - Acceptable',
};

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') || 'download';
  const mode = url.searchParams.get('mode') || 'per-sku';
  const itemIdParam = url.searchParams.get('itemId');
  const itemIdFilter = itemIdParam ? parseInt(itemIdParam) : null;
  const copiesParam = url.searchParams.get('copies');
  const copiesOverride = copiesParam ? parseInt(copiesParam) : null;
  if (action !== 'download' && action !== 'print') {
    return NextResponse.json({ error: "action must be 'download' or 'print'" }, { status: 400 });
  }
  if (mode !== 'per-sku' && mode !== 'per-unit') {
    return NextResponse.json({ error: "mode must be 'per-sku' or 'per-unit'" }, { status: 400 });
  }
  if (itemIdParam && !Number.isFinite(itemIdFilter)) {
    return NextResponse.json({ error: 'Invalid itemId' }, { status: 400 });
  }
  if (copiesParam && (!Number.isFinite(copiesOverride) || (copiesOverride as number) < 1 || (copiesOverride as number) > 200)) {
    return NextResponse.json({ error: 'copies must be 1-200' }, { status: 400 });
  }
  if (copiesOverride && !itemIdFilter) {
    return NextResponse.json({ error: 'copies requires itemId (only valid for single-item printing)' }, { status: 400 });
  }

  const db = getDb();
  let creds: SPAPICredentials | null;
  let printerName: string;
  let items: Array<{ sku: string; productName: string | null; condition: string; quantity: number }>;
  try {
    const batch = db.prepare(`
      SELECT id, status, channel FROM listing_batches WHERE id = ?
    `).get(batchId) as { id: number; status: string; channel: string } | undefined;
    if (!batch) return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'FNSKU labels are only for FBA batches' }, { status: 400 });
    }
    // Need to be at least past send — listings need to exist on Amazon
    // (otherwise the FNSKU fetch will 404).
    if (!['ready', 'boxing', 'placement', 'shipping', 'shipped'].includes(batch.status)) {
      return NextResponse.json({
        error: `FNSKU labels available after Send to Amazon completes (current status: ${batch.status}).`,
      }, { status: 400 });
    }

    items = itemIdFilter
      ? db.prepare(`
          SELECT sku, product_name as productName, condition, quantity
          FROM listing_batch_items WHERE batch_id = ? AND id = ?
        `).all(batchId, itemIdFilter) as any[]
      : db.prepare(`
          SELECT sku, product_name as productName, condition, quantity
          FROM listing_batch_items WHERE batch_id = ?
          ORDER BY id ASC
        `).all(batchId) as any[];

    if (items.length === 0) {
      return NextResponse.json({
        error: itemIdFilter ? 'Item not found in this batch' : 'Batch has no items',
      }, { status: 400 });
    }

    creds = getAmazonCredentials(db);
    printerName = getSetting(db, 'listing_rollo_printer_name') || 'Printer_ThermalPrinter';
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();

  // Fetch FNSKUs for each item from Amazon
  const sellerId = await getSellerId(creds);
  const labelInputs: LabelInput[] = [];
  const missingFnsku: string[] = [];

  for (const item of items) {
    try {
      const listing = await getListing(creds, sellerId, item.sku);
      const fnsku = listing?.summaries?.[0]?.fnSku;
      const productTitle = listing?.summaries?.[0]?.itemName || item.productName || item.sku;
      if (!fnsku) {
        missingFnsku.push(item.sku);
        continue;
      }
      // Quantity rules (in priority order):
      //   1. copiesOverride: explicit count from the per-row "custom qty" UI
      //   2. mode='per-sku': 1 label per unique SKU; user sets copy count at the printer
      //   3. mode='per-unit': 1 label per individual unit; pre-counted, no printer dialog
      const labelQty = copiesOverride
        ? copiesOverride
        : (mode === 'per-sku' ? 1 : item.quantity);
      labelInputs.push({
        fnsku,
        productTitle,
        condition: CONDITION_LABELS[item.condition] || item.condition,
        quantity: labelQty,
      });
    } catch (err) {
      console.warn(`[fnsku-labels] getListing failed for ${item.sku}:`, err);
      missingFnsku.push(item.sku);
    }
  }

  if (labelInputs.length === 0) {
    return NextResponse.json({
      error: 'No FNSKUs available yet — all items still propagating on Amazon. Try again in a minute.',
      missingFnsku,
    }, { status: 400 });
  }

  // Generate the PDF
  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await generateFnskuLabelPdf(labelInputs);
  } catch (err) {
    return NextResponse.json({ error: `PDF generation failed: ${err}` }, { status: 500 });
  }

  // ─── action: download ─── return PDF directly to the browser ──────────
  if (action === 'download') {
    const totalLabels = labelInputs.reduce((s, l) => s + l.quantity, 0);
    const filename = mode === 'per-sku'
      ? `fnsku-labels-batch-${batchId}-${totalLabels}-skus.pdf`
      : `fnsku-labels-batch-${batchId}-${totalLabels}-units.pdf`;
    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBuffer.length),
      },
    });
  }

  // ─── action: print ─── spool to the configured Rollo via macOS lpr ────
  const printResult = await printPdfBuffer(pdfBuffer, printerName, `FlipLedger FNSKU batch-${batchId}`);
  if (!printResult.success) {
    const availablePrinters = await listAvailablePrinters();
    return NextResponse.json({
      success: false,
      error: printResult.error,
      printer: printResult.printer,
      availablePrinters,
      hint: availablePrinters.length === 0
        ? 'No CUPS printers detected. Add the Rollo in System Settings → Printers & Scanners.'
        : `Configured printer "${printResult.printer}" not found. Available: ${availablePrinters.join(', ')}.`,
    }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    printer: printResult.printer,
    jobId: printResult.jobId,
    bytesQueued: printResult.bytesQueued,
    mode,
    labelCount: labelInputs.reduce((s, l) => s + l.quantity, 0),
    skuCount: labelInputs.length,
    totalUnits: items.reduce((s, i) => s + i.quantity, 0),
    missingFnsku: missingFnsku.length > 0 ? missingFnsku : undefined,
  });
}
