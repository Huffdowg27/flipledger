import { NextResponse } from 'next/server';
import { listDetectedPrinters, resolveLabelPrinter } from '@/lib/print';
import { getSetting } from '@/lib/settings';
import { openFlipLedgerDb } from '@/lib/sqlite';

/**
 * GET /api/print/printers
 *
 * Detected CUPS queues (with a 4x6 thermal-label flag), the configured label
 * printer, and which queue labels will actually print to (auto-picks a 4x6
 * printer when none is configured). Drives the Settings printer picker.
 */
export async function GET() {
  const db = openFlipLedgerDb({ readonly: true });
  let configured: string | null;
  try {
    configured = getSetting(db, 'listing_rollo_printer_name');
  } finally {
    db.close();
  }

  try {
    const resolved = await resolveLabelPrinter(configured);
    return NextResponse.json({
      configured: configured || null,
      detected: resolved.detected,
      resolved: { queue: resolved.queue, auto: resolved.auto },
    });
  } catch (err) {
    // lpstat/lpoptions missing (e.g. non-macOS) — report empty, not a 500.
    return NextResponse.json({
      configured: configured || null,
      detected: [],
      resolved: { queue: null, auto: false },
      error: String(err),
    });
  }
}
