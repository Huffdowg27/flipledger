/**
 * One-off backfill: re-push the received (and damaged) count to Airtable for
 * every incoming_purchases row FlipLedger already marked received/partial.
 *
 * Fixes the July 6+ gap where bulk receiving fired writebacks past Airtable's
 * ~5 req/sec limit and the unchecked fetch silently dropped the 429s. Idempotent
 * — it writes FlipLedger's authoritative received count, so re-running is safe.
 *
 * Usage: npx tsx scripts/backfill-airtable-received.ts [--dry]
 */
import Database from 'better-sqlite3';
import path from 'path';
import { writeBackReceived } from '../src/lib/incoming-receipts';

const DRY = process.argv.includes('--dry');

async function main() {
  const db = new Database(path.join('/Users/jamiehuff/flipledger', 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');

  const rows = db.prepare(`
    SELECT ip.id, ip.airtable_record_id AS recId, ip.quantity_received AS received,
      (SELECT COALESCE(SUM(quantity), 0) FROM receiving_issues ri WHERE ri.incoming_purchase_id = ip.id) AS damaged
    FROM incoming_purchases ip
    WHERE ip.status IN ('received', 'partial')
      AND ip.quantity_received > 0
      AND ip.airtable_record_id IS NOT NULL AND ip.airtable_record_id != ''
    ORDER BY ip.received_at
  `).all() as { id: number; recId: string; received: number; damaged: number }[];

  console.log(`${DRY ? '[DRY] ' : ''}Backfilling ${rows.length} received/partial rows to Airtable...`);
  if (DRY) { db.close(); return; }

  let ok = 0, fail = 0;
  const failures: string[] = [];
  for (const r of rows) {
    const res = await writeBackReceived(db, r.recId, r.received, r.damaged);
    if (res.ok) ok++;
    else { fail++; failures.push(`${r.recId} (received ${r.received}): status=${res.status ?? '-'} ${res.error ?? ''}`); }
    await new Promise((resolve) => setTimeout(resolve, 220)); // stay under ~5 req/sec
  }
  db.close();

  console.log(`\nDone. synced=${ok} failed=${fail}`);
  if (failures.length) {
    console.log('Failures:');
    failures.slice(0, 25).forEach((f) => console.log('  ' + f));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
