import type Database from 'better-sqlite3';

export interface RemovalMigrationResult {
  before: number;
  after: number;
  removed: number;
}

interface CurrencyAmount {
  CurrencyAmount?: number;
  CurrencyCode?: string;
}

interface RemovalShipmentItem {
  ASIN?: string;
  SellerSKU?: string;
  Quantity?: number;
  RemovalDisposition?: string;
  FeeAmount?: CurrencyAmount;
}

export interface RemovalShipmentEvent {
  OrderId?: string;
  PostedDate?: string;
  RemovalShipmentItemList?: RemovalShipmentItem[];
}

const REMOVAL_IDENTITY_COLUMNS = `
  removal_order_id,
  COALESCE(asin, ''),
  COALESCE(sku, ''),
  quantity,
  removal_type,
  date_requested,
  COALESCE(fee, 0),
  COALESCE(marketplace, 'amazon')
`;

/**
 * Collapse replayed SP-API removal items and enforce their source identity.
 * `created_at`, status, and other derived labels are deliberately excluded:
 * they describe our ingest, not a distinct Amazon removal item.
 */
export function migrateRemovalIdentities(db: Database.Database): RemovalMigrationResult {
  return db.transaction(() => {
    const before = (db.prepare('SELECT COUNT(*) n FROM removals').get() as { n: number }).n;

    db.exec(`
      DELETE FROM removals
      WHERE id IN (
        SELECT id
        FROM (
          SELECT
            id,
            ROW_NUMBER() OVER (
              PARTITION BY ${REMOVAL_IDENTITY_COLUMNS}
              ORDER BY id ASC
            ) AS replay_number
          FROM removals
        )
        WHERE replay_number > 1
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_removals_source_identity
      ON removals(${REMOVAL_IDENTITY_COLUMNS});
    `);

    const after = (db.prepare('SELECT COUNT(*) n FROM removals').get() as { n: number }).n;
    return { before, after, removed: before - after };
  })();
}

function toUsdCents(amount: CurrencyAmount | undefined): number {
  if (!amount || amount.CurrencyAmount === undefined) return 0;
  if (amount.CurrencyCode && amount.CurrencyCode !== 'USD') {
    throw new Error(`unsupported removal fee currency: ${amount.CurrencyCode}`);
  }
  if (!Number.isFinite(amount.CurrencyAmount)) {
    throw new Error('invalid removal fee amount');
  }
  const cents = Math.round(amount.CurrencyAmount * 100);
  if (!Number.isSafeInteger(cents)) {
    throw new Error('removal fee is outside safe integer range');
  }
  return cents;
}

/**
 * Persist one Amazon RemovalShipmentEvent. The unique source-identity index
 * makes replay a no-op while preserving separate items, quantities, dates, and
 * fees from the same removal order.
 */
export function storeRemovalShipmentEvent(
  db: Database.Database,
  event: RemovalShipmentEvent,
  createdAt: string = new Date().toISOString(),
): number {
  const orderId = event.OrderId?.trim();
  if (!orderId) throw new Error('removal event missing OrderId');

  const postedDate = event.PostedDate?.trim();
  if (!postedDate) throw new Error('removal event missing PostedDate');

  const items = event.RemovalShipmentItemList || [];
  const insert = db.prepare(`
    INSERT OR IGNORE INTO removals (
      removal_order_id, asin, sku, quantity, removal_type, reason, status,
      date_requested, fee, marketplace, created_at
    ) VALUES (?, ?, ?, ?, ?, 'FBA Removal', 'Completed', ?, ?, 'amazon', ?)
  `);

  let inserted = 0;
  for (const item of items) {
    const quantity = item.Quantity ?? 1;
    if (!Number.isSafeInteger(quantity) || quantity < 1) {
      throw new Error(`invalid removal quantity for order ${orderId}`);
    }

    inserted += insert.run(
      orderId,
      item.ASIN?.trim() || null,
      item.SellerSKU?.trim() || null,
      quantity,
      item.RemovalDisposition?.trim() || 'Return',
      postedDate,
      toUsdCents(item.FeeAmount),
      createdAt,
    ).changes;
  }

  return inserted;
}
