import { NextRequest, NextResponse } from 'next/server';
import { getEbayCredentials } from '@/lib/ebay-api/auth';
import { runEbaySync, getEbaySyncStatus } from '@/lib/ebay-api/sync';

export async function GET() {
  const status = getEbaySyncStatus();
  return NextResponse.json({ status });
}

export async function POST(request: NextRequest) {
  const credentials = getEbayCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: 'eBay credentials not configured. Add them in Settings.' },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const lookbackDays = body.lookbackDays || 90;
  const explicitStartDate = body.startDate;
  const explicitEndDate = body.endDate;

  // Start sync in background (don't await)
  runEbaySync(credentials, lookbackDays, explicitStartDate, explicitEndDate).catch(err => {
    console.error('eBay sync background error:', err);
  });

  return NextResponse.json({
    message: 'eBay sync started',
    lookbackDays,
    startDate: explicitStartDate,
    endDate: explicitEndDate,
  });
}
