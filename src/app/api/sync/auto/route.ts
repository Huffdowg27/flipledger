import { NextResponse } from 'next/server';
import { isAutoSyncRunning, startAutoSync } from '@/lib/sp-api/auto-sync';

/**
 * POST /api/sync/auto — start the development auto-sync loop. Production is
 * managed by the dedicated PM2 worker, so this endpoint becomes status-only
 * and can never create a second scheduler in the web process.
 */
export async function POST() {
  if (process.env.FLIPLEDGER_AUTOSYNC_CONTROL === 'external') {
    return NextResponse.json({
      status: isAutoSyncRunning() ? 'running' : 'worker unavailable',
      managedBy: 'flipledger-sync',
    });
  }
  if (startAutoSync()) {
    return NextResponse.json({ status: 'started' });
  }
  return NextResponse.json({ status: 'already running' });
}

/**
 * GET /api/sync/auto — read-only status. Reports whether the loop is running
 * without starting anything.
 */
export async function GET() {
  return NextResponse.json({ status: isAutoSyncRunning() ? 'running' : 'stopped' });
}
