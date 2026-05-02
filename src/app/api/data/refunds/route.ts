import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');
  return db;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get('days') || '30');

  const db = getDb();
  const marketplace = searchParams.get('marketplace');
  const MF = marketplace ? `AND o.marketplace = '${marketplace}'` : '';
  const MF_R = marketplace ? `AND marketplace = '${marketplace}'` : '';

  const cutoff = new Date(Date.now() - days * 86400000).toISOString();

  try {
    const rows = db.prepare(`
      SELECT
        r.refund_date as refundDate,
        r.order_id as orderId,
        r.asin,
        r.sku,
        COALESCE(p.name, p2.name, oi.asin, r.asin) as productName,
        r.quantity,
        r.refund_amount as refundAmount,
        r.reason,
        r.item_returned as itemReturned,
        COALESCE(r.fee_clawback, 0) as feeClawback,
        r.marketplace
      FROM refunds r
      LEFT JOIN products p ON r.asin = p.asin
      LEFT JOIN order_items oi ON r.order_id = oi.order_id
      LEFT JOIN products p2 ON oi.asin = p2.asin
      WHERE r.refund_date >= ?
      ORDER BY r.refund_date DESC
    `).all(cutoff) as any[];

    const items = rows.map((row) => ({
      refundDate: row.refundDate,
      orderId: row.orderId,
      asin: row.asin,
      sku: row.sku,
      productName: row.productName,
      quantity: row.quantity,
      refundAmount: row.refundAmount,
      reason: row.reason,
      itemReturned: !!row.itemReturned,
      feeClawback: row.feeClawback,
      netImpact: row.refundAmount - row.feeClawback,
      marketplace: row.marketplace || 'amazon',
    }));

    const count = items.length;
    const totalRefundAmount = items.reduce((s, i) => s + i.refundAmount, 0);
    const totalClawback = items.reduce((s, i) => s + i.feeClawback, 0);
    const totalNetImpact = items.reduce((s, i) => s + i.netImpact, 0);

    db.close();

    return NextResponse.json({
      items,
      totals: {
        count,
        totalRefundAmount,
        totalClawback,
        totalNetImpact,
      },
    });
  } catch (error) {
    db.close();
    console.error('Refunds API error:', error);
    return NextResponse.json({ error: 'Failed to load refunds data' }, { status: 500 });
  }
}
