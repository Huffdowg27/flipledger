/**
 * Push FlipLedger bins → Veeqo.
 *   GET  → preview (dry-run; writes nothing)
 *   POST → apply (writes locations to Veeqo)
 */
import { NextResponse } from 'next/server';
import { syncVeeqoBins } from '@/lib/veeqo-api/bins';

export async function GET() {
  try {
    return NextResponse.json({ success: true, ...(await syncVeeqoBins({ apply: false })) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}

export async function POST() {
  try {
    return NextResponse.json({ success: true, ...(await syncVeeqoBins({ apply: true })) });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
