import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';
import { ReceiptConflictError, reconcileIncomingPurchase } from '@/lib/incoming-receipts';

function getDb() {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

interface BulkReconcileItem {
  purchaseId: number;
  inventoryLedgerId: number;
  quantity: number;
  expectedQuantityReceived: number;
  receiptKey: string;
}

function parseItem(raw: Record<string, unknown>): BulkReconcileItem {
  const purchaseId = Number(raw.purchaseId);
  if (!Number.isInteger(purchaseId) || purchaseId <= 0) {
    throw new Error('purchaseId must be a positive integer');
  }
  const inventoryLedgerId = Number(raw.inventoryLedgerId);
  if (!Number.isInteger(inventoryLedgerId) || inventoryLedgerId <= 0) {
    throw new Error('inventoryLedgerId must be a positive integer');
  }
  const quantity = Number(raw.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error('quantity must be a positive integer');
  }
  const expectedQuantityReceived = Number(raw.expectedQuantityReceived);
  if (!Number.isInteger(expectedQuantityReceived) || expectedQuantityReceived < 0) {
    throw new Error('expectedQuantityReceived must be a non-negative integer');
  }
  const receiptKey = typeof raw.receiptKey === 'string' ? raw.receiptKey.trim() : '';
  if (!receiptKey || receiptKey.length > 200) {
    throw new Error('receiptKey is required');
  }
  return { purchaseId, inventoryLedgerId, quantity, expectedQuantityReceived, receiptKey };
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!Array.isArray(body)) {
    return NextResponse.json({ error: 'Expected an array of reconciliation rows' }, { status: 400 });
  }

  const db = getDb();
  try {
    const results = [];
    for (const raw of body) {
      let item: BulkReconcileItem | null = null;
      try {
        if (!raw || typeof raw !== 'object') throw new Error('Each row must be an object');
        item = parseItem(raw as Record<string, unknown>);
        const result = await reconcileIncomingPurchase(db, item);
        results.push({
          purchaseId: item.purchaseId,
          ...result,
        });
        // Each real apply fires one Airtable write-back; pace them under
        // Airtable's ~5 req/sec base limit so a big catch-up doesn't 429 itself.
        if (!result.replayed) await new Promise((r) => setTimeout(r, 220));
      } catch (err) {
        const status = err instanceof ReceiptConflictError ? 409 : 400;
        results.push({
          purchaseId: item?.purchaseId ?? null,
          success: false,
          status,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return NextResponse.json({ results });
  } finally {
    db.close();
  }
}
