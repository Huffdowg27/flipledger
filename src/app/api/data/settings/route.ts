import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET() {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
    const settings: Record<string, string> = {};
    for (const row of rows) {
      settings[row.key] = row.value;
    }
    db.close();
    return NextResponse.json({ settings });
  } catch {
    db.close();
    return NextResponse.json({ settings: {} });
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const db = getDb();
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');

  const saveSettings = db.transaction(() => {
    for (const [key, value] of Object.entries(body)) {
      if (typeof value === 'string') {
        upsert.run(key, value);
      }
    }
  });

  try {
    saveSettings();
    db.close();
    return NextResponse.json({ success: true });
  } catch (err) {
    db.close();
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
