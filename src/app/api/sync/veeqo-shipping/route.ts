/**
 * Veeqo shipping-cost sync endpoint.
 *   GET  ?test=1 → Test Connection (fetch 1 order; verifies the API key)
 *   POST         → run the sync ({ overwrite?: boolean })
 */
import { NextRequest, NextResponse } from 'next/server';
import { getVeeqoApiKey, veeqoGet, syncVeeqoShipping } from '@/lib/veeqo-api/shipping';

export async function GET(req: NextRequest) {
  const test = new URL(req.url).searchParams.get('test');
  if (!test) {
    return NextResponse.json({ error: 'Use POST to run the sync, or ?test=1 to test the connection.' }, { status: 400 });
  }
  const apiKey = getVeeqoApiKey();
  if (!apiKey) return NextResponse.json({ ok: false, error: 'No Veeqo API key saved (Settings → Veeqo).' }, { status: 400 });
  try {
    const data = await veeqoGet('/orders?page=1&page_size=1', apiKey);
    const orders = Array.isArray(data) ? data : (data?.orders || []);
    return NextResponse.json({ ok: true, message: `Connected — Veeqo returned ${orders.length} order(s) on the test page.` });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  let overwrite = false;
  try {
    const body = await req.json();
    overwrite = body?.overwrite === true || body?.overwrite === 'true';
  } catch { /* no body */ }

  try {
    const result = await syncVeeqoShipping({ overwrite });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
