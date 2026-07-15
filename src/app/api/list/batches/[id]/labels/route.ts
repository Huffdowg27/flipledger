/**
 * GET /api/list/batches/[id]/labels
 *
 * Fetch FBA inbound carton/FNSKU labels using the FBA Inbound v0 API.
 *
 * There are two distinct label types for an FBA inbound shipment:
 *
 *   type=box  → Box/carton labels (LabelType=BARCODE_2D)
 *               These are the large 2D barcode labels taped to the outside
 *               of each box. Required by Amazon receiving warehouses.
 *               Flow: listShipmentBoxes → extract boxId values →
 *                     getFBAInboundLabels(PackageLabelsToPrint=boxIds)
 *
 *   type=fnsku → FNSKU per-unit labels (LabelType=UNIQUE)
 *                These are the small ASIN/FNSKU labels applied over the
 *                original UPC on each product unit.
 *                Flow: getFBAInboundLabels(LabelType=UNIQUE)
 *
 * IMPORTANT: Do NOT use the v2024-03-20 inboundPlans/.../labels endpoint.
 * That endpoint returns 403 for standard seller accounts. The correct
 * endpoint is: GET /fba/inbound/v0/shipments/{shipmentId}/labels
 *
 * Query params:
 *   type        — 'fnsku' | 'box' (required)
 *   shipmentId  — required: which shipment within the inbound plan
 *   action      — 'download' (default) | 'print'
 *   pageType    — optional, defaults based on type and action
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { clearTokenCache } from '@/lib/sp-api/auth';
import {
  listShipmentBoxes,
  getFBAInboundLabels,
  downloadLabelPdf,
  type LabelPageType,
} from '@/lib/sp-api/inboundPlansV2';
import { printPdfBuffer, listAvailablePrinters } from '@/lib/print';
import type { SPAPICredentials } from '@/lib/sp-api/types';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('busy_timeout = 15000');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
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
  const type = url.searchParams.get('type') || 'box';
  const shipmentId = url.searchParams.get('shipmentId') || '';
  const action = url.searchParams.get('action') || 'download';
  const pageTypeOverride = url.searchParams.get('pageType') as LabelPageType | null;

  // Diagnostic: confirms new route is live (not old getShipmentLabels path)
  console.log('[labels route] USING NEW FBA LABEL FLOW', { batchId, type, shipmentId, action });

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
    if (batch.status !== 'shipping' && batch.status !== 'shipped') {
      return NextResponse.json({
        error: `Labels are only available after placement is confirmed (current status: ${batch.status}).`,
      }, { status: 400 });
    }
    creds = getAmazonCredentials(db);
    inboundPlanId = batch.inboundPlanId;
    // Empty (not a hardcoded default) so printPdfBuffer can auto-pick a
    // detected 4x6 label printer when no queue is configured.
    printerName = getSetting(db, 'listing_rollo_printer_name') || '';
  } finally {
    db.close();
  }

  if (!creds) {
    return NextResponse.json({ error: 'Amazon SP-API credentials not configured' }, { status: 400 });
  }

  clearTokenCache();

  // PageType: thermal when printing to Rollo, letter-size PDF when downloading.
  let pageType: LabelPageType;
  if (pageTypeOverride) {
    pageType = pageTypeOverride;
  } else if (action === 'print') {
    pageType = 'PackageLabel_Thermal';
  } else {
    pageType = type === 'fnsku' ? 'PackageLabel_Letter_6' : 'PackageLabel_Thermal_NonPCP';
  }

  // ── Step 1: get Amazon boxIds from listShipmentBoxes (needed for both box
  //            labels AND to derive the shipmentConfirmationId for the v0 call).
  //
  // CRITICAL: The v0 getLabels endpoint requires the shipmentConfirmationId
  // (e.g. "FBA19CRM1CZ6"), NOT the v2024 shipmentId (e.g. "sh706db819-...").
  // Amazon returns 400 "Invalid information in request" when given the v2024 UUID.
  // The confirmationId can be read from the shipment or derived from the boxId
  // by stripping the trailing U + 6-digit suffix: FBA19CRM1CZ6U000001 → FBA19CRM1CZ6
  let shipmentBoxes: Array<{ boxId: string; [key: string]: any }> = [];
  try {
    shipmentBoxes = await listShipmentBoxes(creds, inboundPlanId!, shipmentId);
    console.log(`[labels] listShipmentBoxes for ${shipmentId}:`, JSON.stringify(shipmentBoxes, null, 2));
  } catch (err) {
    return NextResponse.json({
      error: `listShipmentBoxes failed: ${err}`,
      hint: 'Cannot retrieve box IDs — required to derive shipmentConfirmationId for v0 getLabels.',
    }, { status: 500 });
  }

  const boxIds = shipmentBoxes.map((b) => b.boxId).filter(Boolean);
  if (boxIds.length === 0) {
    return NextResponse.json({
      error: `No box IDs returned from Amazon for shipment ${shipmentId}.`,
      hint: 'Box content must be submitted via setPackingInformation before labels can be printed.',
      raw: shipmentBoxes,
    }, { status: 400 });
  }

  // Derive shipmentConfirmationId: strip trailing U + 6 digits from first boxId.
  // FBA19CRM1CZ6U000001 → FBA19CRM1CZ6
  const firstBoxId = boxIds[0];
  const derivedConfirmationId = firstBoxId.replace(/U\d{6}$/, '');
  const usedConfirmationId = derivedConfirmationId || firstBoxId;

  if (!derivedConfirmationId || derivedConfirmationId === firstBoxId) {
    console.warn('[labels] Could not derive shipmentConfirmationId — boxId did not match expected pattern', {
      v2024ShipmentId: shipmentId,
      firstBoxId,
      usingAsIs: firstBoxId,
    });
  } else {
    console.log('[labels] Using shipmentConfirmationId for v0 getLabels', {
      v2024ShipmentId: shipmentId,
      firstBoxId,
      shipmentConfirmationId: usedConfirmationId,
    });
  }

  const labelShipmentId = usedConfirmationId;

  let downloadUrl: string | null = null;
  let rawLabelResponse: any = null;

  if (type === 'box') {
    console.log('[labels] FINAL ID PASSED TO getFBAInboundLabels', {
      originalV2024ShipmentId: shipmentId,
      labelShipmentId,
      firstBoxId,
      packageLabelsToPrint: boxIds,
    });
    try {
      const result = await getFBAInboundLabels(
        creds,
        labelShipmentId,
        pageType,
        'BARCODE_2D',
        boxIds.length,
        boxIds,
        1, // pageSize — integer, required for Non-Partnered/LTL
        0  // pageStartIndex — integer, zero-based
      );
      downloadUrl = result.downloadUrl;
      rawLabelResponse = result.raw;
    } catch (err) {
      return NextResponse.json({
        error: String(err),
        operation: 'FBA_INBOUND_GET_LABELS',
        endpoint: `/fba/inbound/v0/shipments/${labelShipmentId}/labels`,
        v2024ShipmentId: shipmentId,
        labelShipmentId,
        type,
      }, { status: 500 });
    }
  } else {
    // FNSKU labels must NOT go through Amazon getLabels (LabelType=UNIQUE requires
    // cartonIdList which this endpoint doesn't provide). Use /fnsku-labels instead.
    return NextResponse.json({
      error: 'Use /api/list/batches/:id/fnsku-labels for FNSKU labels — they are generated locally from listing data, not via Amazon getLabels.',
    }, { status: 400 });
  }

  if (!downloadUrl) {
    return NextResponse.json({
      error: `No download URL in Amazon label response. Raw: ${JSON.stringify(rawLabelResponse).slice(0, 500)}`,
      hint: 'Check rawLabelResponse — Amazon v0 labels are at payload.URL',
    }, { status: 500 });
  }

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await downloadLabelPdf(downloadUrl);
  } catch (err) {
    return NextResponse.json({ error: `Failed to download label PDF: ${err}` }, { status: 500 });
  }

  if (action === 'download') {
    const filename = type === 'box'
      ? `box-labels-${shipmentId}.pdf`
      : `fnsku-labels-${shipmentId}.pdf`;
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

  // action === 'print' — spool to Rollo via macOS lpr
  const printResult = await printPdfBuffer(
    pdfBuffer,
    printerName,
    `FlipLedger Box labels ${shipmentId}`
  );

  if (!printResult.success) {
    const availablePrinters = await listAvailablePrinters();
    return NextResponse.json({
      success: false,
      error: printResult.error,
      printer: printResult.printer,
      availablePrinters,
      hint: availablePrinters.length === 0
        ? 'No CUPS printers detected. Add the Rollo in System Settings → Printers & Scanners.'
        : `Printer "${printResult.printer}" not found. Available: ${availablePrinters.join(', ')}. Update settings.listing_rollo_printer_name.`,
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
