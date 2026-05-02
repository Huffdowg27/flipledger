/**
 * Global lookup endpoint — search by order_id, PO, customer order #, ASIN, SKU,
 * reimbursement_id, or product name. Returns categorized matches across all
 * entity types so the user can pick what they actually wanted.
 */

import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

interface LookupResult {
  type: 'order' | 'reimbursement' | 'product' | 'refund' | 'batch';
  id: string;
  href: string;
  title: string;
  subtitle?: string;
  marketplace?: string;
  amountCents?: number;
  date?: string;
}

export async function GET(request: NextRequest) {
  const q = (request.nextUrl.searchParams.get('q') || '').trim();
  const limitPerType = parseInt(request.nextUrl.searchParams.get('limit') || '5', 10);

  if (q.length < 2) {
    return NextResponse.json({ query: q, results: [] });
  }

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });

  try {
    const like = `%${q}%`;
    const results: LookupResult[] = [];

    // ----- Orders by order_id (exact prefix preferred) -----
    const orders = db.prepare(`
      SELECT o.order_id, o.purchase_date, o.marketplace, o.status, o.fulfillment_channel,
             (SELECT COALESCE(SUM(total_price), 0) FROM order_items WHERE order_id = o.order_id) AS total_cents,
             (SELECT name FROM products p WHERE p.asin = (SELECT asin FROM order_items WHERE order_id = o.order_id LIMIT 1) LIMIT 1) AS pname
      FROM orders o
      WHERE o.order_id LIKE ?
      ORDER BY CASE WHEN o.order_id = ? THEN 0 ELSE 1 END, o.purchase_date DESC
      LIMIT ?
    `).all(like, q, limitPerType) as Array<{ order_id: string; purchase_date: string; marketplace: string; status: string; fulfillment_channel: string; total_cents: number; pname: string | null }>;

    for (const o of orders) {
      results.push({
        type: 'order',
        id: o.order_id,
        href: `/lookup/${encodeURIComponent(o.order_id)}`,
        title: o.order_id,
        subtitle: `${o.pname ? o.pname + ' · ' : ''}${o.fulfillment_channel} · ${o.status}`,
        marketplace: o.marketplace,
        amountCents: o.total_cents,
        date: o.purchase_date,
      });
    }

    // ----- Walmart Customer Order # (lives in financial_events.raw_data) -----
    if (/^\d{12,}$/.test(q)) {
      const custMatches = db.prepare(`
        SELECT order_id, json_extract(raw_data, '$."Customer Order #"') AS cust_oid, MIN(posted_date) AS posted_date, marketplace
        FROM financial_events
        WHERE marketplace = 'walmart'
          AND json_extract(raw_data, '$."Customer Order #"') = ?
          AND order_id IS NOT NULL
          AND order_id NOT IN (SELECT order_id FROM orders WHERE order_id LIKE ?)
        GROUP BY order_id
        ORDER BY posted_date DESC
        LIMIT ?
      `).all(q, like, limitPerType) as Array<{ order_id: string; cust_oid: string; posted_date: string; marketplace: string }>;

      for (const c of custMatches) {
        if (!c.order_id) continue;
        results.push({
          type: 'order',
          id: c.order_id,
          href: `/lookup/${encodeURIComponent(c.order_id)}`,
          title: c.order_id,
          subtitle: `Walmart Customer Order ${c.cust_oid}`,
          marketplace: 'walmart',
          date: c.posted_date,
        });
      }
    }

    // ----- Reimbursements by reimbursement_id -----
    const reimbs = db.prepare(`
      SELECT reimbursement_id, reimbursement_date, asin, sku, reason, amount, marketplace
      FROM reimbursements
      WHERE reimbursement_id LIKE ?
      ORDER BY reimbursement_date DESC
      LIMIT ?
    `).all(like, limitPerType) as Array<{ reimbursement_id: string; reimbursement_date: string; asin: string | null; sku: string | null; reason: string | null; amount: number; marketplace: string }>;

    for (const r of reimbs) {
      results.push({
        type: 'reimbursement',
        id: r.reimbursement_id,
        href: `/bookkeep/reimbursements?search=${encodeURIComponent(r.reimbursement_id)}`,
        title: r.reimbursement_id,
        subtitle: `${r.reason || 'Reimbursement'}${r.sku ? ' · ' + r.sku : ''}`,
        marketplace: r.marketplace,
        amountCents: r.amount,
        date: r.reimbursement_date,
      });
    }

    // ----- Products by ASIN, SKU, or name -----
    const products = db.prepare(`
      SELECT p.asin, p.name, p.marketplace,
             (SELECT sku FROM order_items WHERE asin = p.asin LIMIT 1) AS sku
      FROM products p
      WHERE p.asin LIKE ? OR p.name LIKE ?
      ORDER BY CASE WHEN p.asin = ? THEN 0 ELSE 1 END
      LIMIT ?
    `).all(like, like, q, limitPerType) as Array<{ asin: string; name: string; marketplace: string; sku: string | null }>;

    for (const p of products) {
      results.push({
        type: 'product',
        id: p.asin,
        href: `/products?search=${encodeURIComponent(p.asin)}`,
        title: p.name || p.asin,
        subtitle: p.asin + (p.sku && p.sku !== p.asin ? ' · ' + p.sku : ''),
        marketplace: p.marketplace,
      });
    }

    // ----- Order items by SKU (for SKU-only lookups, find the order) -----
    const skuOrders = db.prepare(`
      SELECT DISTINCT oi.order_id, oi.sku, o.purchase_date, o.marketplace, o.status,
             (SELECT name FROM products WHERE asin = oi.asin LIMIT 1) AS pname
      FROM order_items oi
      JOIN orders o ON o.order_id = oi.order_id
      WHERE (oi.sku = ? OR oi.asin = ?)
        AND oi.order_id NOT IN (SELECT order_id FROM orders WHERE order_id LIKE ?)
      ORDER BY o.purchase_date DESC
      LIMIT ?
    `).all(q, q, like, limitPerType) as Array<{ order_id: string; sku: string; purchase_date: string; marketplace: string; status: string; pname: string | null }>;

    for (const s of skuOrders) {
      results.push({
        type: 'order',
        id: s.order_id,
        href: `/lookup/${encodeURIComponent(s.order_id)}`,
        title: s.order_id,
        subtitle: `${s.pname ? s.pname + ' · ' : ''}SKU ${s.sku} · ${s.status}`,
        marketplace: s.marketplace,
        date: s.purchase_date,
      });
    }

    // ----- Listing batches by name -----
    const batches = db.prepare(`
      SELECT id, name, status, channel, created_at,
             (SELECT COUNT(*) FROM listing_batch_items WHERE batch_id = listing_batches.id) AS item_count
      FROM listing_batches
      WHERE name LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(like, limitPerType) as Array<{ id: number; name: string; status: string; channel: string; created_at: string; item_count: number }>;

    for (const b of batches) {
      results.push({
        type: 'batch',
        id: String(b.id),
        href: `/list/${b.id}`,
        title: b.name,
        subtitle: `${b.channel} · ${b.status} · ${b.item_count} items`,
        date: b.created_at,
      });
    }

    return NextResponse.json({ query: q, results });
  } finally {
    db.close();
  }
}
