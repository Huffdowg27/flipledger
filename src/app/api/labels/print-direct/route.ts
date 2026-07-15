/**
 * POST /api/labels/print-direct — silent ASIN sticker printing.
 *
 * Renders 2"×1" ASIN stickers as a PDF (lib/asin-labels) and spools them
 * straight to the configured label printer via lpr (lib/print) — no browser
 * print dialog. Used by the MFN batch receive auto-print-on-save toggle.
 *
 * Body: { specs: [{ asin, title?, condition?, bin?, copies? }], action? }
 *   action 'print' (default) → JSON PrintResult passthrough; a print failure
 *     returns success:false with the error, never a thrown 500, so the UI
 *     can fall back to the manual print path.
 *   action 'download' → the PDF bytes (debug / fallback).
 */
import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { buildAsinLabelPdf, MAX_COPIES_PER_SPEC, AsinLabelSpec } from '@/lib/asin-labels';
import { printPdfBuffer } from '@/lib/print';

const MAX_SPECS = 50;

function getSetting(key: string): string | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value || null;
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  let body: { specs?: unknown; action?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const action = body.action === 'download' ? 'download' : 'print';
  if (!Array.isArray(body.specs) || body.specs.length < 1 || body.specs.length > MAX_SPECS) {
    return NextResponse.json({ error: `specs must be an array of 1-${MAX_SPECS} labels` }, { status: 400 });
  }

  const specs: AsinLabelSpec[] = [];
  for (const raw of body.specs as Array<Record<string, unknown>>) {
    const asin = typeof raw?.asin === 'string' ? raw.asin.trim() : '';
    if (!asin) {
      return NextResponse.json({ error: 'Every spec needs a non-empty asin' }, { status: 400 });
    }
    const copies = Math.min(MAX_COPIES_PER_SPEC, Math.max(1, Math.trunc(Number(raw.copies) || 1)));
    specs.push({
      asin,
      title: typeof raw.title === 'string' ? raw.title : undefined,
      condition: typeof raw.condition === 'string' ? raw.condition : undefined,
      bin: typeof raw.bin === 'string' ? raw.bin : undefined,
      copies,
    });
  }

  let pdf: Buffer;
  try {
    pdf = await buildAsinLabelPdf(specs);
  } catch (err) {
    return NextResponse.json({ error: `Label render failed: ${String(err)}` }, { status: 500 });
  }

  if (action === 'download') {
    return new NextResponse(new Uint8Array(pdf), {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="asin-labels.pdf"',
      },
    });
  }

  const printerName = getSetting('listing_rollo_printer_name') || '';
  const result = await printPdfBuffer(pdf, printerName, 'FlipLedger ASIN stickers');
  return NextResponse.json(result);
}
