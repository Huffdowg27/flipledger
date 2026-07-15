import { NextRequest, NextResponse } from 'next/server';
import { redactSettings, resolveSettingsUpdates } from '@/lib/settings-policy';
import { readSettings, upsertSettings } from '@/lib/settings';
import { openFlipLedgerDb } from '@/lib/sqlite';

export async function GET() {
  const db = openFlipLedgerDb({ readonly: true });
  try {
    // Never return stored secrets to the client — only a "set" sentinel.
    return NextResponse.json({ settings: redactSettings(readSettings(db)) });
  } catch {
    return NextResponse.json({ settings: {} });
  } finally {
    db.close();
  }
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const db = openFlipLedgerDb();

  // Allowlist known keys and preserve secrets submitted as the redaction
  // sentinel (unedited fields). See src/lib/settings-policy.ts.
  const updates = resolveSettingsUpdates(body);

  try {
    upsertSettings(db, updates);
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  } finally {
    db.close();
  }
}
