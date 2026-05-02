/**
 * GET /api/list/batches/[id]/labels
 *
 * Fetch FNSKU and box ID labels from Amazon for a confirmed-placement
 * shipment, and either stream them to the browser as a PDF or spool them
 * directly to the user's Rollo thermal printer.
 *
 * Query params:
 *   type        — 'fnsku' (per-unit FNSKU labels) | 'box' (per-box ID labels)
 *   shipmentId  — required: which shipment within the inbound plan
 *   action      — 'download' (default) returns the PDF; 'print' spools to printer
 *   pageType    — optional, defaults to 'PackageLabel_Letter_6' (4 labels per page)
 *                 For Rollo thermal: try 'PackageLabel_Thermal' (4×6) and crop on the printer
 *
 * Returns:
 *   action=download: PDF file (Content-Type: application/pdf)
 *   action=print:    JSON { success, printer, jobId, bytesQueued }
 *
 * Requires the batch to be in 'shipping' status or later (placement confirmed,
 * shipments exist).
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  getShipmentLabels,
  downloadLabelPdf,
  type LabelPageType,
  type LabelType,
} from '@/lib/sp-api/inboundPlansV2';
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

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const batchId = parseInt(id);
  if (!Number.isFinite(batchId)) {
    return NextResponse.json({ error: 'Invalid batch id' }, { status: 400 });
  }

  const url = new URL(request.url);
  const type = url.searchParams.get('type') || 'fnsku';      // fnsku | box
  const shipmentId = url.searchParams.get('shipmentId') || '';
  const action = url.searchParams.get('action') || 'download'; // download | print
  const pageTypeOverride = url.searchParams.get('pageType') as LabelPageType | null;

  if (!shipmentId) {
    return NextResponse.json({ error: 'shipmentId is required' }, { status: 400 });
  }
  if (type !== 'fnsku' && type !== 'box') {
    return NextResponse.json({ error: "type must be 'fnsku' or 'box'" }, { status: 400 });
  }
  if (action !== 'download' && action !== 'print') {
    return NextResponse.json({ error: "action must be 'download' or 'print'" }, { status: 400 });
  }

  const db = getDb();
  let creds: SPAPICredentials | null;
  let inboundPlanId: string | null;
  let printerName: string;
  try {
    const batch = db.prepare(`
      SELECT id, status, channel, inbound_plan_id as inboundPlanId
      FROM listing_batches WHERE id = ?
    `).get(batchId) as { id: number; status: string; channel: string; inboundPlanId: string | null } | undefined;
    if (!batch) {
      return NextResponse.json({ error: 'Batch not found' }, { status: 404 });
    }
    if (batch.channel !== 'FBA') {
      return NextResponse.json({ error: 'Labels are only for FBA batches' }, { status: 400 });
    }
    if (!batch.inboundPlanId) {
      return NextResponse.json({ error: 'Batch has no inbound plan id' }, { status: 400 });
    }
    // Labels exist only after placement is confirmed (i.e., shipments are
    // generated). Phase 3 transitions batch to 'shipping' on placement
    // confirm. Anything earlier and the shipmentId won't be valid.
    if (batch.status !== 'shipping' && batch.status !== 'shipped') {
      return NextResponse.json({
        error: `Labels are only available after placement is confirmed (current status: ${batch.status}).`,
      }, { status: 400 });
    }
    creds = getAmazonCredentials(db);
    inboundPlanId = batch.inboundPlanId;
    printerName = getSetting(db, 'listing_rollo_printer_name') || 'Printer ThermalPrinter';
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();

  // Map (type, action) → SP-API params.
  // FNSKU per-unit labels = LabelType=UNIQUE
  // Box ID labels        = LabelType=BARCODE_2D
  // PageType: thermal (4×6) when printing to Rollo, Letter_6 when downloading
  // for the user to print on standard paper.
  const labelType: LabelType = type === 'fnsku' ? 'UNIQUE' : 'BARCODE_2D';
  let pageType: LabelPageType;
  if (pageTypeOverride) {
    pageType = pageTypeOverride;
  } else if (action === 'print') {
    pageType = 'PackageLabel_Thermal'; // Rollo is thermal
  } else {
    pageType = type === 'fnsku' ? 'PackageLabel_Letter_6' : 'PackageLabel_Plain_Paper';
  }

  let labelsResponse;
  try {
    labelsResponse = await getShipmentLabels(creds, inboundPlanId, shipmentId, pageType, labelType);
  } catch (err) {
    return NextResponse.json({ error: `Amazon getShipmentLabels failed: ${err}` }, { status: 500 });
  }

  // Amazon returns either documents[].url or downloadURL — handle both.
  const downloadUrl =
    labelsResponse?.documents?.[0]?.url ||
    labelsResponse?.downloadURL ||
    null;
  if (!downloadUrl) {
    return NextResponse.json({
      error: `No download URL returned from Amazon. Raw response: ${JSON.stringify(labelsResponse).slice(0, 500)}`,
    }, { status: 500 });
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await downloadLabelPdf(downloadUrl);
  } catch (err) {
    return NextResponse.json({ error: `Failed to download label PDF: ${err}` }, { status: 500 });
  }

  // ─── Action: download ─── return the PDF directly to the browser ───────
  if (action === 'download') {
    const filename = `${type}-labels-${shipmentId}.pdf`;
    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': String(pdfBuffer.length),
        'Cache-Control': 'private, max-age=300',
      },
    });
  }

  // ─── Action: print ─── spool to the configured Rollo via macOS lpr ─────
  const printResult = await printPdfBuffer(
    pdfBuffer,
    printerName,
    `FlipLedger ${type === 'fnsku' ? 'FNSKU' : 'Box ID'} ${shipmentId}`
  );

  if (!printResult.success) {
    // If the printer name was wrong, list what's actually available so the
    // user can pick the right one in Settings.
    const availablePrinters = await listAvailablePrinters();
    return NextResponse.json({
      success: false,
      error: printResult.error,
      printer: printResult.printer,
      availablePrinters,
      hint: availablePrinters.length === 0
        ? 'No CUPS printers detected on this Mac. Add the Rollo in System Settings → Printers & Scanners.'
        : `Configured printer "${printResult.printer}" not found. Available: ${availablePrinters.join(', ')}. Update settings.listing_rollo_printer_name.`,
    }, { status: 500 });
  }

  return NextResponse.json({
    success: true,
    printer: printResult.printer,
    jobId: printResult.jobId,
    bytesQueued: printResult.bytesQueued,
    type,
    shipmentId,
  });
}
