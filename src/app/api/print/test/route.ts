import { NextRequest, NextResponse } from 'next/server';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { printPdfBuffer } from '@/lib/print';
import { getSetting } from '@/lib/settings';
import { openFlipLedgerDb } from '@/lib/sqlite';

/**
 * POST /api/print/test
 * Body: { queue?: string }
 *
 * Renders a small 4x6 test label and prints it, so the user can validate a
 * label printer from Settings without a real shipment. If `queue` is omitted,
 * uses the configured printer / auto-picked 4x6 printer (same resolution as
 * real label printing).
 */
export async function POST(request: NextRequest) {
  let queue = '';
  try {
    const body = await request.json().catch(() => ({}));
    if (typeof body?.queue === 'string') queue = body.queue.trim();
  } catch { /* empty body is fine */ }

  if (!queue) {
    const db = openFlipLedgerDb({ readonly: true });
    try {
      queue = getSetting(db, 'listing_rollo_printer_name') || '';
    } finally {
      db.close();
    }
  }

  // Build a minimal 4x6" (288x432pt) test label.
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([288, 432]);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawRectangle({ x: 8, y: 8, width: 272, height: 416, borderColor: rgb(0, 0, 0), borderWidth: 1 });
  page.drawText('FlipLedger', { x: 24, y: 360, size: 30, font: bold });
  page.drawText('Test Label - 4x6', { x: 24, y: 320, size: 18, font: bold });
  page.drawText('If you can read this, direct', { x: 24, y: 280, size: 12, font: regular });
  page.drawText('print to your label printer works.', { x: 24, y: 262, size: 12, font: regular });
  page.drawText(new Date().toLocaleString(), { x: 24, y: 220, size: 11, font: regular });
  const pdfBuffer = Buffer.from(await pdf.save());

  const result = await printPdfBuffer(pdfBuffer, queue, 'FlipLedger Test Label');
  return NextResponse.json(result, { status: result.success ? 200 : 400 });
}
