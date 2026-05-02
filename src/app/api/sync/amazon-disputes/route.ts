/**
 * POST /api/sync/amazon-disputes
 *
 * Re-classifies Amazon refunds against the current state of refunds +
 * reimbursements + orders. Pure SQL, runs in milliseconds.
 */
import { NextResponse } from 'next/server';
import { syncAmazonDisputeCandidates } from '@/lib/sp-api/amazonDisputeCandidates';
import Database from 'better-sqlite3';
import path from 'path';

export async function POST() {
  try {
    const result = syncAmazonDisputeCandidates();

    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('amazon_disputes_last_sync', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date().toISOString());
    db.close();

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
