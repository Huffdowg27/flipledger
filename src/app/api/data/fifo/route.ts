/**
 * FIFO COGS recalculation endpoint.
 *
 * POST /api/data/fifo — recalculate all COGS
 * POST /api/data/fifo?sku=XXX — recalculate specific SKU
 * POST /api/data/fifo?asin=XXX — recalculate specific ASIN
 */
import { NextRequest, NextResponse } from 'next/server';
import { recalculateFIFO } from '@/lib/fifo';

export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const sku = searchParams.get('sku');
  const asin = searchParams.get('asin');

  const startTime = Date.now();
  const result = recalculateFIFO({
    sku: sku || undefined,
    asin: asin || undefined,
    recalcAll: !sku && !asin,
  });
  const elapsed = Date.now() - startTime;

  return NextResponse.json({
    ...result,
    elapsedMs: elapsed,
  });
}

export async function GET() {
  return NextResponse.json({
    description: 'FIFO COGS recalculation',
    usage: {
      'POST /api/data/fifo': 'Recalculate ALL COGS (may take a few seconds)',
      'POST /api/data/fifo?sku=XXX': 'Recalculate specific SKU',
      'POST /api/data/fifo?asin=XXX': 'Recalculate specific ASIN',
    },
  });
}
