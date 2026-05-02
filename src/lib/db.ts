import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'flipledger.db');

const sqlite = new Database(DB_PATH);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

// Create tables if they don't exist
export function initializeDatabase() {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      records_fetched INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      sku TEXT,
      name TEXT,
      category TEXT,
      image_url TEXT,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      walmart_item_id TEXT
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL UNIQUE,
      purchase_date TEXT NOT NULL,
      status TEXT NOT NULL,
      marketplace TEXT DEFAULT 'amazon',
      fulfillment_channel TEXT NOT NULL,
      is_estimated INTEGER DEFAULT 1,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS order_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      asin TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      price_per_unit INTEGER NOT NULL,
      total_price INTEGER NOT NULL,
      shipping_charged INTEGER DEFAULT 0,
      shipping_cost INTEGER DEFAULT 0,
      promotional_rebate INTEGER DEFAULT 0,
      cogs_per_unit INTEGER DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_order_items_unique ON order_items(order_id, asin, sku);

    CREATE TABLE IF NOT EXISTS financial_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      posted_date TEXT NOT NULL,
      order_id TEXT,
      asin TEXT,
      sku TEXT,
      marketplace TEXT DEFAULT 'amazon',
      total_amount INTEGER NOT NULL,
      raw_data TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS fee_details (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      financial_event_id INTEGER NOT NULL,
      order_id TEXT,
      asin TEXT,
      fee_type TEXT NOT NULL,
      fee_category TEXT,
      amount INTEGER NOT NULL,
      posted_date TEXT NOT NULL,
      effective_date TEXT
    );

    CREATE TABLE IF NOT EXISTS live_inventory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      sku TEXT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      fulfillable_qty INTEGER NOT NULL DEFAULT 0,
      inbound_qty INTEGER NOT NULL DEFAULT 0,
      reserved_qty INTEGER NOT NULL DEFAULT 0,
      unfulfillable_qty INTEGER NOT NULL DEFAULT 0,
      total_qty INTEGER GENERATED ALWAYS AS (fulfillable_qty + inbound_qty + reserved_qty + unfulfillable_qty) STORED,
      product_name TEXT,
      last_updated TEXT NOT NULL,
      inbound_working INTEGER DEFAULT 0,
      inbound_shipped INTEGER DEFAULT 0,
      inbound_receiving INTEGER DEFAULT 0,
      reserved_customer_order INTEGER DEFAULT 0,
      reserved_fc_transfer INTEGER DEFAULT 0,
      reserved_fc_processing INTEGER DEFAULT 0,
      list_price INTEGER DEFAULT 0,
      walmart_item_id TEXT,
      UNIQUE(asin, sku, marketplace)
    );

    CREATE TABLE IF NOT EXISTS inbound_cost_per_sku (
      sku TEXT NOT NULL,
      asin TEXT,
      shipment_id TEXT NOT NULL,
      inbound_cost_per_unit INTEGER NOT NULL,
      units INTEGER NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (sku, shipment_id)
    );

    CREATE TABLE IF NOT EXISTS storage_fees_per_asin (
      asin TEXT PRIMARY KEY,
      monthly_fee INTEGER NOT NULL,
      size_tier TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inventory_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      sku TEXT,
      buy_price INTEGER NOT NULL,
      quantity INTEGER NOT NULL,
      quantity_remaining INTEGER NOT NULL,
      supplier_id INTEGER,
      date_purchased TEXT NOT NULL,
      notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER DEFAULT 1,
      refund_amount INTEGER NOT NULL,
      reason TEXT,
      item_returned INTEGER DEFAULT 0,
      fee_clawback INTEGER DEFAULT 0,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reimbursements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reimbursement_id TEXT,
      reimbursement_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      reason TEXT,
      amount INTEGER NOT NULL,
      quantity INTEGER DEFAULT 1,
      status TEXT DEFAULT 'Approved',
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS removals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      removal_order_id TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      quantity INTEGER NOT NULL,
      removal_type TEXT NOT NULL,
      reason TEXT,
      status TEXT DEFAULT 'Pending',
      date_requested TEXT NOT NULL,
      date_completed TEXT,
      fee INTEGER DEFAULT 0,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_shipments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id TEXT NOT NULL,
      date_shipped TEXT NOT NULL,
      carrier TEXT,
      tracking TEXT,
      boxes INTEGER DEFAULT 1,
      weight REAL,
      cost INTEGER NOT NULL,
      total_units INTEGER NOT NULL,
      status TEXT DEFAULT 'In Transit',
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS inbound_shipment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id TEXT NOT NULL,
      asin TEXT NOT NULL,
      sku TEXT,
      quantity INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      recurring TEXT DEFAULT 'one-time',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recurring_expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      active INTEGER DEFAULT 1,
      start_date TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS other_income (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      income_type TEXT NOT NULL,
      amount INTEGER NOT NULL,
      description TEXT,
      marketplace TEXT DEFAULT 'amazon',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sales_tax (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT,
      state TEXT NOT NULL,
      tax_collected INTEGER NOT NULL,
      marketplace_facilitator_tax INTEGER DEFAULT 0,
      posted_date TEXT NOT NULL,
      marketplace TEXT DEFAULT 'amazon'
    );

    -- Amazon reimbursement re-evaluation candidates. For each reimbursement
    -- Amazon already paid, we compare the paid amount to (avg sale price ×
    -- qty). When Amazon paid significantly less, the seller can file a
    -- "Submit a reimbursement claim dispute" case to ask Amazon to
    -- re-evaluate. This is the dispute path that requires a reimbursement_id.
    CREATE TABLE IF NOT EXISTS amazon_reimbursement_reevaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reimbursement_id TEXT NOT NULL,
      reimbursement_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
      quantity INTEGER NOT NULL,
      paid_cents INTEGER NOT NULL,
      expected_cents INTEGER NOT NULL,
      gap_cents INTEGER NOT NULL,
      reason TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_reeval_unique
      ON amazon_reimbursement_reevaluations(reimbursement_id);
    CREATE INDEX IF NOT EXISTS idx_amazon_reeval_status
      ON amazon_reimbursement_reevaluations(status);

    -- Amazon dispute candidates (SAFE-T claims). Same pattern as Walmart's
    -- table — computed from refunds + reimbursements, no extra API call.
    -- Surfaces customer refunds where the seller can dispute via SAFE-T
    -- (e.g., customer returned wrong item, claimed never-arrived despite
    -- delivery confirmation). 90-day filing window from refund date.
    CREATE TABLE IF NOT EXISTS amazon_dispute_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      return_reason TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
      refund_amount_cents INTEGER NOT NULL,
      fulfillment_channel TEXT,
      eligibility TEXT NOT NULL,
      eligibility_reasons TEXT,
      dispute_window_until TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_amazon_dispute_unique
      ON amazon_dispute_candidates(refund_id);
    CREATE INDEX IF NOT EXISTS idx_amazon_dispute_status
      ON amazon_dispute_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_amazon_dispute_window
      ON amazon_dispute_candidates(dispute_window_until);

    -- Walmart dispute candidates. Computed from the refunds table, NOT
    -- from a separate API report. For each Walmart refund, we determine
    -- whether the seller can dispute Walmart's auto-refund decision
    -- (typically only for WFS-fulfilled orders within 30 days of refund).
    CREATE TABLE IF NOT EXISTS walmart_dispute_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      refund_id INTEGER NOT NULL,
      order_id TEXT NOT NULL,
      refund_date TEXT NOT NULL,
      return_reason TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      product_name TEXT,
      refund_amount_cents INTEGER NOT NULL,
      fulfillment_channel TEXT,                  -- WFS, Seller, or null
      eligibility TEXT NOT NULL,                 -- eligible | maybe | not_eligible
      eligibility_reasons TEXT,                  -- JSON array of tag strings
      dispute_window_until TEXT,                 -- refund_date + 30 days
      status TEXT NOT NULL DEFAULT 'pending',    -- pending | filed | received | dismissed | expired
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_walmart_dispute_unique
      ON walmart_dispute_candidates(refund_id);
    CREATE INDEX IF NOT EXISTS idx_walmart_dispute_status
      ON walmart_dispute_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_walmart_dispute_window
      ON walmart_dispute_candidates(dispute_window_until);

    -- Reimbursement candidates from the FBA Inventory Adjustments report.
    -- Each row is a negative-quantity adjustment (lost/damaged/missing in
    -- warehouse) that hasn't been reimbursed yet. Surfaces dollars Amazon
    -- owes us that we can file claims for in Seller Central.
    CREATE TABLE IF NOT EXISTS reimbursement_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adjustment_date TEXT NOT NULL,
      asin TEXT,
      sku TEXT,
      fnsku TEXT,
      product_name TEXT,
      fulfillment_center_id TEXT,
      reason TEXT NOT NULL,
      disposition TEXT,
      quantity INTEGER NOT NULL,            -- negative = loss, positive = found
      estimated_value_cents INTEGER,        -- abs(quantity) × buy_price (best estimate)
      eligible_until TEXT,                  -- 60 days from adjustment_date (Amazon's claim window)
      status TEXT NOT NULL DEFAULT 'pending', -- pending, matched, filed, received, expired, dismissed
      matched_reimbursement_id INTEGER,     -- FK to reimbursements.id when we detect a match
      filed_at TEXT,
      claim_notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reimbursement_candidates_unique
      ON reimbursement_candidates(adjustment_date, COALESCE(fnsku,''), COALESCE(asin,''), reason, quantity);
    CREATE INDEX IF NOT EXISTS idx_reimbursement_candidates_status
      ON reimbursement_candidates(status);
    CREATE INDEX IF NOT EXISTS idx_reimbursement_candidates_eligible
      ON reimbursement_candidates(eligible_until);

    -- Amazon DD+7 reserve balance history. Captured from settlement reports
    -- whenever Amazon includes "Current Reserve Amount" / "Previous Reserve
    -- Amount Balance" lines (classic Deferred Disbursement schedule). For
    -- accounts on Express Payments / Faster Payouts, no reserve rows are
    -- emitted, so this table stays empty and the dashboard card hides.
    CREATE TABLE IF NOT EXISTS reserve_balance_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      posted_date TEXT NOT NULL,
      current_reserve_cents INTEGER NOT NULL DEFAULT 0,
      previous_reserve_cents INTEGER NOT NULL DEFAULT 0,
      settlement_id TEXT,
      raw_data TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reserve_balance_unique
      ON reserve_balance_history(marketplace, posted_date, current_reserve_cents);
    CREATE INDEX IF NOT EXISTS idx_reserve_balance_date
      ON reserve_balance_history(posted_date);

    -- Best-Sellers-Rank snapshots from Catalog API. One row per
    -- (asin, captured_date) — daily granularity is enough.
    CREATE TABLE IF NOT EXISTS sales_rank_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      category TEXT,
      rank INTEGER,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      captured_date TEXT NOT NULL DEFAULT (date('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_rank_unique ON sales_rank_history(asin, marketplace, captured_date);
    CREATE INDEX IF NOT EXISTS idx_sales_rank_asin ON sales_rank_history(asin);
    CREATE INDEX IF NOT EXISTS idx_sales_rank_captured ON sales_rank_history(captured_date);

    CREATE INDEX IF NOT EXISTS idx_orders_purchase_date ON orders(purchase_date);
    CREATE INDEX IF NOT EXISTS idx_orders_fulfillment ON orders(fulfillment_channel);
    CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
    CREATE INDEX IF NOT EXISTS idx_order_items_asin ON order_items(asin);
    CREATE INDEX IF NOT EXISTS idx_financial_events_posted ON financial_events(posted_date);
    CREATE INDEX IF NOT EXISTS idx_financial_events_order ON financial_events(order_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_financial_events_unique ON financial_events(
      event_type, COALESCE(order_id,''), COALESCE(asin,''), COALESCE(sku,''), posted_date, total_amount
    );
    CREATE INDEX IF NOT EXISTS idx_fee_details_event ON fee_details(financial_event_id);
    CREATE INDEX IF NOT EXISTS idx_fee_details_order ON fee_details(order_id);
    CREATE INDEX IF NOT EXISTS idx_fee_details_type ON fee_details(fee_type);
    CREATE INDEX IF NOT EXISTS idx_inventory_ledger_asin ON inventory_ledger(asin);
    CREATE INDEX IF NOT EXISTS idx_refunds_order ON refunds(order_id);
    CREATE INDEX IF NOT EXISTS idx_reimbursements_date ON reimbursements(reimbursement_date);
    CREATE INDEX IF NOT EXISTS idx_removals_date ON removals(date_requested);
    CREATE INDEX IF NOT EXISTS idx_sales_tax_date ON sales_tax(posted_date);
    CREATE INDEX IF NOT EXISTS idx_sales_tax_state ON sales_tax(state);
    CREATE INDEX IF NOT EXISTS idx_products_asin ON products(asin);

    -- Listing tool: user-created batches (separate from synced inbound_shipments)
    CREATE TABLE IF NOT EXISTS listing_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      channel TEXT NOT NULL DEFAULT 'FBA',
      ship_from_name TEXT,
      ship_from_address_line1 TEXT,
      ship_from_city TEXT,
      ship_from_state TEXT,
      ship_from_postal_code TEXT,
      ship_from_country_code TEXT DEFAULT 'US',
      ship_from_phone TEXT,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      inbound_plan_id TEXT,
      inbound_operation_id TEXT,
      plan_status TEXT,
      send_error TEXT,
      sent_at TEXT,
      -- Phase 3: Packing (what's in each box) ───────────────────────────
      packing_operation_id TEXT,
      packing_option_id TEXT,
      packing_group_id TEXT,
      packing_status TEXT,            -- IN_PROGRESS | SUCCESS | FAILED
      packing_confirmed_at TEXT,
      packing_error TEXT,
      -- Phase 3: Placement (which FCs get the boxes) ────────────────────
      placement_operation_id TEXT,
      placement_option_id TEXT,
      placement_status TEXT,          -- IN_PROGRESS | SUCCESS | FAILED
      placement_fee_cents INTEGER,    -- fee for the chosen placement option
      placement_confirmed_at TEXT,
      placement_error TEXT,
      notes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS listing_batch_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      asin TEXT NOT NULL,
      sku TEXT NOT NULL,
      msku TEXT,
      product_name TEXT,
      image_url TEXT,
      condition TEXT NOT NULL DEFAULT 'NewItem',
      quantity INTEGER NOT NULL DEFAULT 1,
      list_price_cents INTEGER NOT NULL DEFAULT 0,
      buy_price_cents INTEGER NOT NULL DEFAULT 0,
      supplier TEXT,
      purchase_date TEXT,
      estimated_fee_cents INTEGER DEFAULT 0,
      estimated_ship_cents INTEGER DEFAULT 0,
      listing_status TEXT,
      listing_submission_id TEXT,
      listing_error TEXT,
      listing_updated_at TEXT,
      labels_printed_at TEXT,  -- when the user marks this SKU as physically labeled
      created_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES listing_batches(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_listing_batch_items_batch ON listing_batch_items(batch_id);
    CREATE INDEX IF NOT EXISTS idx_listing_batches_status ON listing_batches(status);

    -- Phase 3: Boxes the seller has actually packed for an FBA batch.
    -- The user enters dimensions/weight here and assigns items to each box.
    -- This is what gets sent to setPackingInformation on the SP-API.
    -- packing_group_id: Amazon's pack group this box belongs to (Amazon may
    -- split a batch into multiple groups for bulky/oversize items, each
    -- group ships separately). Optional for single-group batches.
    CREATE TABLE IF NOT EXISTS listing_batch_boxes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      box_index INTEGER NOT NULL,   -- 1-based display order within group
      length_in REAL,
      width_in REAL,
      height_in REAL,
      weight_lb REAL,
      packing_group_id TEXT,         -- Amazon's pack group ID (pgXXX)
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES listing_batches(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_listing_batch_boxes_batch ON listing_batch_boxes(batch_id);

    -- Pack groups Amazon assigns when generatePackingOptions runs. For diverse
    -- inventory (mix of bulky + standard), Amazon splits items into multiple
    -- groups, each group ships as its own shipment to potentially a different
    -- FC. The seller boxes each group separately.
    CREATE TABLE IF NOT EXISTS listing_batch_pack_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      batch_id INTEGER NOT NULL,
      packing_group_id TEXT NOT NULL,            -- Amazon's group identifier
      group_index INTEGER NOT NULL,              -- display order (0, 1, 2, ...)
      created_at TEXT NOT NULL,
      FOREIGN KEY (batch_id) REFERENCES listing_batches(id) ON DELETE CASCADE,
      UNIQUE(batch_id, packing_group_id)
    );
    CREATE INDEX IF NOT EXISTS idx_pack_groups_batch ON listing_batch_pack_groups(batch_id);

    -- Which batch items belong to which pack group, with quantities. Sourced
    -- from Amazon's listPackingGroupItems response.
    CREATE TABLE IF NOT EXISTS listing_batch_pack_group_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pack_group_id INTEGER NOT NULL,            -- FK to listing_batch_pack_groups.id
      item_id INTEGER NOT NULL,                  -- FK to listing_batch_items.id
      quantity INTEGER NOT NULL,
      FOREIGN KEY (pack_group_id) REFERENCES listing_batch_pack_groups(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES listing_batch_items(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pack_group_items_group ON listing_batch_pack_group_items(pack_group_id);

    -- Phase 3: Which items are packed in which box. Many-to-many between
    -- listing_batch_items and listing_batch_boxes with a quantity field so
    -- an item's quantity can be split across multiple boxes if needed.
    CREATE TABLE IF NOT EXISTS listing_batch_box_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      box_id INTEGER NOT NULL,
      item_id INTEGER NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (box_id) REFERENCES listing_batch_boxes(id) ON DELETE CASCADE,
      FOREIGN KEY (item_id) REFERENCES listing_batch_items(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_listing_batch_box_items_box ON listing_batch_box_items(box_id);
    CREATE INDEX IF NOT EXISTS idx_listing_batch_box_items_item ON listing_batch_box_items(item_id);

    -- Fee estimates cache (Phase 1 listing tool): stores SP-API fees estimate results per ASIN.
    -- Scales linearly with price on lookup; TTL of 24h enforced in code.
    CREATE TABLE IF NOT EXISTS fee_estimates_cache (
      asin TEXT NOT NULL,
      marketplace TEXT NOT NULL DEFAULT 'amazon',
      list_price_cents INTEGER NOT NULL,
      fee_cents INTEGER NOT NULL,
      referral_fee_cents INTEGER DEFAULT 0,
      fba_fee_cents INTEGER DEFAULT 0,
      estimated_at TEXT NOT NULL,
      PRIMARY KEY (asin, marketplace)
    );
  `);
}
