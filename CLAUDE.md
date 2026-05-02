# CLAUDE.md — FlipLedger

This file is for Claude (or any AI coding assistant) working on the FlipLedger
codebase. It captures design decisions, gotchas, and patterns that are easy
to get wrong without context.

For setup and what FlipLedger does, see [`README.md`](README.md).

---

## The mission

FlipLedger is production software a reseller runs their business on and files
taxes from. The numbers must be correct. If profit is off by a penny, it's
wrong.

**Accuracy is the product.** Pretty UI with wrong numbers is worse than ugly
UI with right numbers.

---

## Stack

- **Framework:** Next.js (App Router) + TypeScript strict mode
- **DB:** SQLite via `better-sqlite3` (single file at `data/flipledger.db`)
- **Charts:** Recharts
- **Tables:** TanStack Table (sort, filter, search, CSV export, pagination)
- **Auth:** None — single-user local app
- **Money:** All monetary values stored as **integer cents**. Float math is forbidden.

---

## Schema overview

Core tables (see `src/lib/db.ts` for full schema):

| Table | Purpose |
|---|---|
| `orders` | One row per marketplace order |
| `order_items` | Line items, includes `cogs_per_unit` filled by FIFO |
| `financial_events` | Raw events from each marketplace's financial API (sales, fees, refunds, reimbursements) |
| `fee_details` | Every individual fee broken out (referral, FBA fulfillment, storage, etc.) |
| `refunds` | Customer refunds with reason |
| `reimbursements` | Marketplace credits (FBA inventory, dispute settlements, incentives) |
| `inventory_ledger` | Multi-lot COGS tracking — one row per buy lot |
| `live_inventory` | Real-time FBA / WFS stock counts |
| `recurring_expenses` | Templates for monthly expenses (UI-managed, no hardcoded list) |
| `expenses` | Generated expense rows |
| `sales_tax` | Marketplace facilitator tax tracking |
| `sync_log` | Audit trail of every sync run |
| `settings` | API credentials + per-key config |

---

## Design rules (the ones easy to get wrong)

### 1. Money is integer cents
Store $19.99 as `1999`. Convert to dollars only for display. Never round in
intermediate calculations.

### 2. Single source of truth for profit math
Every profit / ROI / margin calculation goes through `src/lib/calculations.ts`.
If you find yourself inlining a formula in a route handler, you're creating a
bug. Add it to the lib instead.

### 3. Cash basis is the default
The P&L counts revenue / fees / refunds at the moment of marketplace
settlement, not at order placement. This matches actual bank deposits.

The P&L page has a Cash/Accrual toggle. Cash is correct for tax filing.
Accrual exists to reconcile against tools like InventoryLab.

### 4. Marketplace fees are stored raw
Don't sum fees into a "total_fees" column. Each fee type Amazon / Walmart /
eBay sends gets its own row in `fee_details`. The P&L groups them in the UI.

This matters because:
- Amazon adds new fee types over time (we adapt automatically)
- Tax filing requires the breakdown

### 5. FIFO COGS, multi-lot
COGS is calculated by walking each SKU's `inventory_ledger` rows in
`date_purchased` order, depleting oldest lot first. Re-runs after any
inventory price change.

The single-lot upsert endpoint (`POST /api/data/products`) is legacy — for new
buys at different prices, use the multi-lot endpoint
(`POST /api/data/inventory-lots`).

---

## Patterns from real-world bug fixes

These are the kinds of issues you'll run into. Patterns to apply when you do.

### Self-healing dedup, not insert-time prevention
Several upstream APIs assign different IDs to the same logical event. Examples:
- Amazon FBA reimbursements have THREE possible sources (Financial Events
  AdjustmentEvent, Settlement Reports, FBA Reimbursements Report) — each
  generates its own ID for the same payment.
- Walmart recon reports send refund-related rows in multiple line items per
  return; older code paths classified them inconsistently.

**Don't** try to dedup at insert time. Race conditions and stale code caches
defeat it.

**Do** run a self-healing sweep at the end of every sync that consolidates
duplicates. The sweep is idempotent. See:
- `src/lib/sp-api/dedupReimbursements.ts` — Amazon ADJ/SETTLEMENT → numeric canonical
- `src/lib/walmart-api/dedupRecon.ts` — old-path WalmartReconEvent zombies

### Granular unique indexes
The original `financial_events` unique index was
`(event_type, order_id, asin, sku, posted_date)` with day-level posted_date
truncation. This silently dropped multiple distinct line items per order per
day (e.g. Walmart sends 5 line items per refund — only the first was kept).

**Pattern:** when an upstream system can produce N records sharing the same
key tuple, the unique index must include a per-record value (amount,
transaction_key) — not just IDs assigned by an upstream system.

Current `financial_events` index: `(event_type, order_id, asin, sku, posted_date, total_amount)`.

### Settlement-stage sourcing for cash-basis financials
When an upstream API has multi-stage flow (initiated → issued → settled),
**count from the LATEST stage**, not the earliest. Examples:
- Walmart refunds: counted when the recon `WalmartRefundEvent` posts (settled),
  not when the customer initiated the return.
- Amazon sales: counted when `ShipmentEvent` posts, not when the customer
  placed the order.

Counting earlier stages overstates revenue / understates expenses with
in-flight items that may never settle.

### COALESCE in unique indexes
SQLite treats NULL != NULL in unique indexes by default. This means rows with
NULL fields in the index never collide and sync re-runs duplicate them.

**Pattern:** `UNIQUE(event_type, COALESCE(order_id,''), COALESCE(asin,''), ...)`.

---

## Sync architecture

```
auto-sync (hourly cron)
    ├── Amazon: runFullSync()
    │     ├── syncOrders
    │     ├── syncFinancialEvents
    │     ├── syncFBAInventory
    │     ├── enrichProductCatalog
    │     ├── syncSettlementReports
    │     ├── overrideEstimatedFees + estimateAndBackfillFees
    │     ├── generateRecurringExpenses
    │     └── dedupAmazonReimbursements (self-healing)
    │
    ├── Customer Returns (separate report; FBA only)
    ├── Sales Rank (daily — uses Catalog API)
    ├── Reimbursements Report (weekly — slow async report)
    │     └── dedupAmazonReimbursements
    ├── Reimbursement Candidates (weekly)
    ├── Walmart: runWalmartSync()
    │     ├── syncOrders (WFS + Seller Fulfilled separately)
    │     ├── syncReturns
    │     ├── syncFBAInventory + syncInboundShipments (WFS)
    │     ├── syncAllReconReports
    │     └── dedupWalmartReconEvents (self-healing)
    └── eBay: syncEbayOrders
```

Settings keys for last-sync timestamps: `lastSync` (Amazon), `walmart_last_sync`,
`ebay_last_sync`, plus per-report timestamps for the slower weekly syncs.

---

## Anti-patterns (instant callout)

- Storing monetary values as floats → NO. Integer cents.
- A `total_fees` column instead of broken-out fee rows → NO. Tax filing needs the breakdown.
- Calculating profit differently on two pages → BUG. Single source in `calculations.ts`.
- Pretty UI with wrong numbers → unacceptable.
- "I'll handle the API integration later and use mock data" → fine for initial UI work, but mock data must be replaced before any page is considered done.
- Hardcoding marketplace fee types → NO. Store the raw fee type string. Categorize in the UI.

---

## Where the bodies are buried

- **Walmart Orders API only returns ~6 months.** Anything older than that has fees from recon but no orders. Filing those via a prior tool is the recommended workaround.
- **Amazon Inbound Plans v2024** — `setPackingInformation` requires an account-level entitlement that's case-by-case granted by SP-API. The current code path is correct, just blocked at the API. Workaround: use Seller Central and call `/sync-from-amazon` to import the resulting plan.
- **eBay Finances API** requires Application Growth Check approval (2-3 days). Without it, fees come from `Fulfillment.totalMarketplaceFee` per order — less granular but workable.
- **Recon report dates** — Walmart uses `MM/DD/YYYY`, settlement reports use both `YYYY-MM-DD` and `DD.MM.YYYY` depending on cadence. The parser handles both.

---

## Self-check before merging changes that touch sync / P&L

1. Are monetary values stored as integer cents?
2. Is profit math going through `calculations.ts`?
3. Does the unique index on any new table include a per-record value?
4. Does the parser preserve raw signs (positive credits stay positive)?
5. Did you back up `data/flipledger.db` before running any destructive migration?

If any answer is wrong, fix it before merging.
