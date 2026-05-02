import { NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { syncReimbursementReevaluations } from '@/lib/sp-api/reimbursementReevaluations';

export async function POST() {
  try {
    const result = syncReimbursementReevaluations();

    const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.prepare(`
      INSERT INTO settings (key, value) VALUES ('amazon_reevaluations_last_sync', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(new Date().toISOString());
    db.close();

    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
