import { NextResponse } from 'next/server';
import { openFlipLedgerDb } from '@/lib/sqlite';
import { getSettlementDripStatus } from '@/lib/sp-api/settlement-drip-backfill';

export async function GET() {
  const db = openFlipLedgerDb({ readonly: true });
  try {
    return NextResponse.json(getSettlementDripStatus(db));
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
