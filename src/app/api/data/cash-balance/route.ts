/**
 * Cash balance — Amazon's Deferred Disbursement (DD+7) reserve breakdown.
 *
 * Amazon holds funds for 7 days after delivery before they become disbursable
 * to your bank. Each settlement report includes:
 *   - "Current Reserve Amount"        — cash currently held
 *   - "Previous Reserve Amount Balance" — cash that was held last cycle
 *
 * We surface the latest snapshot plus a trend so you can see "available now
 * vs held in DD+7" and understand cash flow timing.
 */

import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

export async function GET(_request: NextRequest) {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    // Latest reserve snapshot
    const latest = db.prepare(`
      SELECT marketplace, posted_date, current_reserve_cents, previous_reserve_cents
      FROM reserve_balance_history
      ORDER BY posted_date DESC, id DESC
      LIMIT 1
    `).get() as { marketplace: string; posted_date: string; current_reserve_cents: number; previous_reserve_cents: number } | undefined;

    // Trend over the last 12 settlement cycles
    const history = db.prepare(`
      SELECT marketplace, posted_date, current_reserve_cents, previous_reserve_cents
      FROM reserve_balance_history
      ORDER BY posted_date DESC, id DESC
      LIMIT 12
    `).all() as Array<{ marketplace: string; posted_date: string; current_reserve_cents: number; previous_reserve_cents: number }>;

    // Pending Amazon revenue not yet settled (everything since the last reserve report
    // posted as ShipmentEvent, that hasn't been disbursed yet). Approximation.
    let pendingSinceLastReserveCents = 0;
    if (latest?.posted_date) {
      const r = db.prepare(`
        SELECT COALESCE(SUM(total_amount), 0) AS total
        FROM financial_events
        WHERE marketplace = 'amazon'
          AND event_type = 'ShipmentEvent'
          AND posted_date > ?
      `).get(latest.posted_date) as { total: number };
      pendingSinceLastReserveCents = r?.total || 0;
    }

    return NextResponse.json({
      latest: latest
        ? {
            marketplace: latest.marketplace,
            postedDate: latest.posted_date,
            currentReserveCents: latest.current_reserve_cents,
            previousReserveCents: latest.previous_reserve_cents,
            deltaCents: latest.current_reserve_cents - latest.previous_reserve_cents,
          }
        : null,
      history: history.reverse().map((h) => ({
        postedDate: h.posted_date,
        currentReserveCents: h.current_reserve_cents,
        previousReserveCents: h.previous_reserve_cents,
      })),
      pendingSinceLastReserveCents,
    });
  } finally {
    db.close();
  }
}
