/**
 * POST /api/sync/walmart-disputes
 *
 * Scans the refunds table and refreshes walmart_dispute_candidates.
 * Cheap and fast (pure SQL, no API calls).
 */
import { NextResponse } from 'next/server';
import { syncWalmartDisputeCandidates } from '@/lib/walmart-api/disputeCandidates';
import Database from 'better-sqlite3';
import path from 'path';

export async function POST() {
  try {
    const result = syncWalmartDisputeCandidates();

    // Track last-sync time
    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('walmart_disputes_last_sync', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date().toISOString());
    db.close();

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
