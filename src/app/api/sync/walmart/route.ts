import { NextRequest, NextResponse } from 'next/server';
import { getWalmartCredentials } from '@/lib/walmart-api/auth';
import { runWalmartSync, getWalmartSyncStatus } from '@/lib/walmart-api/sync';

export async function GET() {
  const status = getWalmartSyncStatus();
  return NextResponse.json({ status });
}

export async function POST(request: NextRequest) {
  const credentials = getWalmartCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: 'Walmart credentials not configured. Add them in Settings.' },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const lookbackDays = body.lookbackDays || 90;
  const explicitStartDate = body.startDate; // ISO string
  const explicitEndDate = body.endDate;     // ISO string

  // Start sync in background (don't await)
  runWalmartSync(credentials, lookbackDays, explicitStartDate, explicitEndDate).catch(err => {
    console.error('Walmart sync background error:', err);
  });

  return NextResponse.json({
    message: 'Walmart sync started',
    lookbackDays,
    startDate: explicitStartDate,
    endDate: explicitEndDate,
  });
}
