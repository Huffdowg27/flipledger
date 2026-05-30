import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';

import { buildMfnUploadList, normalizeAirtableMfnRow, type AirtableRecord } from '@/lib/mfn-upload-list';

const DEFAULT_E2A_BASE_ID = 'app8OwHDGugzOlskO';
const DEFAULT_E2A_TABLE_ID = 'tblSJJcb6p5HDbD8f';
const DEFAULT_VIEW = 'IL FBM Upload Today';

function airtableToken(): string {
  if (process.env.AIRTABLE_API_KEY) return process.env.AIRTABLE_API_KEY;

  // Local Jamie stack fallback: FlipLedger runs from /Users/jamiehuff/flipledger,
  // while the Airtable/Gmail/Amazon integration token currently lives in fba-pipeline.
  // Server-side only; never returned to the browser.
  try {
    const env = fs.readFileSync('/Users/jamiehuff/fba-pipeline/.env', 'utf8');
    const line = env.split(/\r?\n/).find(l => l.trim().startsWith('AIRTABLE_API_KEY='));
    return line?.split('=', 2)[1]?.trim().replace(/^['"]|['"]$/g, '') ?? '';
  } catch {
    return '';
  }
}

async function fetchAirtableRecords({ baseId, tableId, view }: { baseId: string; tableId: string; view: string }) {
  const token = airtableToken();
  if (!token) {
    throw new Error('AIRTABLE_API_KEY is not configured');
  }

  const records: AirtableRecord[] = [];
  let offset = '';
  do {
    const url = new URL(`https://api.airtable.com/v0/${baseId}/${tableId}`);
    url.searchParams.set('pageSize', '100');
    if (view) url.searchParams.set('view', view);
    if (offset) url.searchParams.set('offset', offset);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Airtable ${res.status}: ${body.slice(0, 300)}`);
    }

    const data = await res.json() as { records?: AirtableRecord[]; offset?: string };
    records.push(...(data.records ?? []));
    offset = data.offset ?? '';
  } while (offset);

  return records;
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const baseId = params.get('baseId') || process.env.E2A_AIRTABLE_BASE_ID || DEFAULT_E2A_BASE_ID;
  const tableId = params.get('tableId') || process.env.E2A_AIRTABLE_TABLE_ID || DEFAULT_E2A_TABLE_ID;
  const view = params.get('view') || process.env.E2A_MFN_UPLOAD_VIEW || DEFAULT_VIEW;

  try {
    const airtableRows = await fetchAirtableRecords({ baseId, tableId, view });
    const rows = airtableRows.map(normalizeAirtableMfnRow);
    const result = buildMfnUploadList(rows);
    return NextResponse.json({
      source: { baseId, tableId, view, fetchedRows: airtableRows.length },
      ...result,
    });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
