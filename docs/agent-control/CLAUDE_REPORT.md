# Claude Report — MFN Visual Polish + COGS Audit Checkpoint

_Last updated: 2026-05-17. Covers commits 28f2efa through 09991e9._

---

## 2026-06-08 — Trustworthiness/VPS-readiness audit (DEPLOYED)

Full findings: `docs/agent-control/AUDIT_2026-06-08.md`. Shipped commits b8d4bca→8a7feba,
deployed via pm2 stop→build→start (verified: homepage 200, /api/data/data-integrity live).
DB backed up to `data/flipledger.pre-audit-deploy-20260608-185530.db` before deploy.

- **F1** profit math centralized in `calculations.ts` (8 surfaces; numbers identical) + `npm test`.
- **F3** `recalcAll` now deterministic/idempotent (was rewriting 5 items every run); +$92.96 one-time.
- **F4** new `/analyze/data-integrity` guardrail (Tools nav).
- **F2** `extractCogsFromSku` unwraps `amzn.gr.` prefix (partial; backfill RUN deferred).
- **F6** infinite-lot is now the fail-SAFE default (`FIFO_IL_FINITE=true` to disable); the old
  opt-in `FIFO_IL_INFINITE` flag could silently destroy COGS if omitted.

**Deferred (need Jamie):** run COGS backfill (~$2,210 recoverable); confirm IF_/SFLIP_/MF-Kohl's
SKU-cost parser formats + manual costs for FD-/6D-/numeric ASINs (~$1,436); push to remote.
Tests: 15 pass. Nothing pushed (still local on `main`).

---

## 2026-06-05 — Margin added to reports + MFN ship-cost gap diagnosed (uncommitted)

**Margin alongside ROI (operator prefers margin):**
- `/analyze/profitability` — the API already returned `margin` (route line 201); it was just
  never displayed. Added a **Margin%** column (after Gross ROI%), a Margin StatCard, footer
  total, and CSV column. No calc change — `calculations.ts` already has `calculateMargin`.
- `/bookkeep/merchant-sales` — route already computed `profitPercent` (= profit/salePrice =
  margin); added a **Margin** column + CSV. (FBA & WFS sales pages already had it.)
- `/bookkeep/ebay-sales` — added Margin column + CSV to match.
- Verified live: profitability totals ROI 31.4% / Margin 17.5%; a merchant-sales row ROI
  110.7% / Margin 64.3% (margin < ROI as expected). tsc+build clean, deployed.

**MFN ship-cost $0.00 gap — DIAGNOSED, not a display bug:**
- Ship cost is sourced from Amazon **settlement reports** ("Shipping label purchase" line)
  and applied automatically in the normal sync (`reports.ts:392`) — same logic as the manual
  `/api/sync/import-shipping` route. NOT from financial events (0 financial_events contain
  "Postage").
- Coverage by month: Apr 10/10, May 58/66, Jun 9/18; **pre-Feb-2026 = 0** because Amazon's
  report API only returns recent settlements (`settlement_periods` oldest = 2026-02-16).
- The recent zeros are settlement-availability + **API throttling**: a re-run of import-shipping
  got **26/26 settlement-document fetches 429'd** ("failed after 3 retries"). A gentle targeted
  scan of the 8 newest reports (period May 27→Jun 5) found NO label line for the May 14-18
  orders — but those charges post in older (~mid-May) reports I couldn't reach through the 429s.
- Today's (Jun 5) zeros are simply not-yet-settled. Did NOT hammer the throttled endpoint
  (known 429-wedge risk). Self-heals as settlement reports post + a clean settlement sync runs.
  Labels bought OUTSIDE Amazon Buy Shipping have no settlement line → need manual/CSV entry.

---

## 2026-06-05 — MFN Orders: real ship-service level + per-status tab counts (uncommitted)

**Behavior changed (`/mfn/orders`):**
- Shipping column no longer hard-codes "Standard". It now shows the real Amazon
  delivery promise as a color-coded badge: Standard (neutral), Expedited (info),
  2nd Day (warning), Next/Same Day (negative), Priority/Scheduled (info).
- Status tabs renamed/extended to **Ready to Ship · Pending · Shipped · Canceled · All Open**,
  each with a live count badge (Canceled badge turns red when > 0).
- Status column is now status-aware (CANCELED / SHIPPED / OPEN), not always "OPEN+PAID".

**Files changed:**
- `src/lib/db.ts` — added `orders.ship_service_level TEXT` column migration.
- `src/lib/sp-api/orders.ts` — `syncOrders` captures `ShipmentServiceLevelCategory`;
  `reconcileOpenOrders` backfills it for already-synced open orders (UPDATE … WHERE ship_service_level IS NULL).
- `src/app/api/data/mfn-orders/route.ts` — returns `shipServiceLevel`; new `statusCounts`
  object (awaiting/pending/shipped/canceled/all) over MFN scope; added `canceled` statusClause.
- `src/app/mfn/orders/page.tsx` — ship-level badge, tab counts, canceled tab, status-aware badges.

**Data:** migration applied to `data/flipledger.db`; one-off SP-API backfill populated
ship levels for all 14 current open/canceled MFN orders (matches Seller Central:
Le Creuset=SecondDay, Fujifilm Instax Mini 9=Expedited, rest Standard).

**Verified:** `npx tsc --noEmit` clean; `npm run build` clean; deployed via pm2 stop→build→start
(NOT restart). API on :3002 returns `statusCounts {awaiting:6,pending:2,shipped:1918,canceled:6,all:8}`
with correct per-order ship levels.

**Risk:** Money/P&L untouched (read-only operational view). New orders get ship level on next
sync automatically; `reconcileOpenOrders` self-heals any that synced before this change.

### Follow-up — photos for Pending orders (display-only, FIFO-safe)

**Problem:** Pending orders showed no photo because Amazon's bulk getOrders hides line
items while Pending, so `order_items` holds an opaque `asin='PENDING'` placeholder.
**Key accuracy fact:** FIFO (`fifo.ts:128,136`) only excludes Canceled — **Pending orders
ARE consumed by FIFO**. So putting the real SKU into `order_items` would deplete inventory
and could mint a phantom auto-ledger lot (`orders.ts:175-194`) for an unsettled order.

**Solution (display-only, never touches order_items/COGS/inventory):**
- `db.ts` — new `orders.preview_asin TEXT` (documented as display-only, do-not-feed-FIFO).
- `orders.ts` — new `resolvePendingPreviews` pass: for Pending orders in the sync batch,
  calls getOrderItems (which DOES return the real ASIN), stores it in `orders.preview_asin`
  and upserts a display-only `products` row; `enrichProductCatalog` fills the image on its pass.
  Throttled 1.5s. order_items stays `PENDING`.
- `mfn-orders/route.ts` — `LEFT JOIN products pv ON pv.asin = o.preview_asin`; outer SELECT
  uses `COALESCE(NULLIF(pi.x,'PENDING'), pv.x)` so pending rows resolve photo/title/ASIN.

**Verified:** both current pending orders backfilled (Godzilla Rodan B07QWMWNNF, NECA
Xenomorph Queen B00LK4BWUC) — API `status=pending` now returns asin + imageUrl for both.
tsc clean, build OK, deployed pm2 stop→build→start. Still uncommitted on `main`.

---

## ⚠️ Critical Warnings for Next Agent

1. **COGS canary repair IS complete (5 SKUs, -$641.95).** The remaining
   **114 tier 1 SKUs have NOT been repaired yet.** Do not re-run the canary.
   Do not assume all COGS numbers are correct — 114 SKUs still have
   `cogs_per_unit = 0` on overflow orders.

2. **Keep MFN UI work strictly separate from COGS/P&L work.** These are two
   independent threads. Do not mix them in a single task or commit.

3. **Do not stage or commit `CLAUDE.md`, `docs/agent-control/`, or
   `docs/design-reference/` unless Jamie explicitly asks.**

---

## Thread A — MFN Visual Polish (COMPLETE through 8e0fe05)

### Commits in this session (UI-only, newest first)

| Commit | Summary |
|---|---|
| `8e0fe05` | Secondary form fields de-emphasized: Bin/Est.Shipping h-7 + dim labels; Shipping Template label dim; Qty/Price/Condition unchanged |
| `e732cf4` | Card header compressed: image w-14→w-8, title text-sm line-clamp-2→text-xs line-clamp-1, standalone SKU line removed, items-start→items-center |
| `490a58e` | Inset elevation fix: info chips/UpcChip/overflow badge bg-slate-900/60, profit strip bg-slate-900/40, image placeholders bg-slate-700/40, drawer Close button bg-slate-900/40 |
| `30b46c2` | Full token pass: purple/indigo accent → blue-400/500/600 throughout; bg-bg-elevated→bg-slate-800; bg-bg-surface→bg-slate-800; page container bg-slate-900; purple ChannelBadge→slate |
| `a10e426` | Stale comments updated after Not inspected demotion (comment-only) |
| `ce28b26` | Not inspected chip: blocker(red) → warn(amber). Push gating unchanged in activation-push and activation-preview routes |
| `883febe` | Card layout: removed helper banner, tightened profit strip, 3-col grid (Qty/Price/Condition row 1; BuyCost/Bin/Shipping row 2), full Enter chain with primaryActionRef on both Save buttons |
| `12e0f17` | No condition: warn→info (gray/muted). No longer drives needsWork |
| `4bbcd62` | Removed operator-facing "lot" wording from all visible strings |
| `28f2efa` | Calmed unsaved workflow: added info ChipTone, Fee unknown→info, saved row green left accent only (no glow), unsaved count muted |

### What changed visually
- **Palette**: Navy/slate workbench (bg-slate-900 floor, bg-slate-800 panels). Blue primary actions. No purple/indigo accent anywhere.
- **Warning hierarchy**: Red = true blockers (No price, Not inspected now demoted). Amber = push-readiness warnings (Not inspected, Stale status). Gray = metadata caveats (Fee unknown, No condition).
- **Unsaved card**: Compact header (32px image, 1-line title), 3-col input grid, secondary fields visually de-emphasized.
- **Saved rows**: Dense 40px rows with green left accent. No glow backgrounds.
- **Language**: "Save item" / "Save changes" — no "lot" terminology in the UI.

### What behavior was intentionally NOT changed
- Save/create flow (`onCreateLot`, `onSave`, `/create-mfn-local-lot` API)
- Activation preview and push (`activation-preview/route.ts`, `activation-push/route.ts`)
- SP-API writes of any kind
- Shipping template sync logic
- Fee math, profit math, COGS, FIFO, P&L, accounting
- Orders, FBA, labels, schema, `inventory_ledger.quantity_remaining`
- `inspected_at` push gating in both activation routes (unchanged)
- Enter keyboard chain and all form refs

### Known remaining UI issues (not yet addressed)
1. **Expanded unsaved card is still tall (~300–350px) vs saved rows (40px).** The header is now compressed but the 6-field form + profit strip + save button still create a large card. Closing this gap requires a drawer or inline-row editing approach — scoped separately.
2. **`+N` overflow badge on saved rows**: `bg-slate-900/60` blends with `bg-slate-900` page floor. Only visible via hairline border. Edge case (requires 2+ warn chips simultaneously); acceptable for now.
3. **Search dropdown result rows** have no per-row separator when multiple results appear — all `bg-slate-800` on `bg-slate-800` dropdown. Low priority.

### Verification (all passing as of 8e0fe05)
- `npm run build`: ✓ clean
- `/mfn/batch`: ✓ 200
- `/analyze/merchant-inventory`: ✓ 200
- All commits: only `src/app/mfn/batch/page.tsx` changed

---

## Thread B — COGS Gap Audit + Partial Repair

### Commits (newest first)
| Commit | Summary |
|---|---|
| `09991e9` | Canary execution record — 5 SKUs repaired, -$641.95 verified |
| `4621326` | COGS canary repair plan (5-SKU dry-run approach) |
| `dcdbc0d` | Tier 1 COGS gap dry-run repair plan (119 SKUs, -$5,321.86) |
| `bd62fe7` | Read-only COGS gap audit (120 affected SKUs, $5,361 missing COGS) |

### Status — canary COMPLETE, bulk repair PENDING

**Canary (DONE):**
- 5 SKUs repaired: `LV_01BBL_040126_14.08_30_10_P_411`, `LV_01FAFLIP_033026_79.99_141_10_P_375`, `LV_04WAL_040726_19.97_37_40_P_457`, `ZTPC_02DYS_022426_1.99_18_10_P_187`, `1070145738`
- `inventory_ledger.quantity` updated for ledger ids `44704, 44733, 44633, 44827, 44585`
- FIFO run scoped to those 5 SKUs only — 23 `order_items` corrected
- 16 previously-correct rows verified unchanged (zero regressions)
- Actual P&L delta: **-$641.95** (matched plan prediction exactly)
- `quantity_remaining` stayed 0 on all 5 lots
- DB backup at: `data/flipledger.db.bak-pre-canary-20260517`
- Full record: `docs/audits/cogs-gap-canary-execution-2026-05-17.md`

**Remaining 114 tier 1 SKUs (NOT YET REPAIRED):**
- Estimated remaining P&L delta: **-$4,679.91**
- Full candidate list with exact `ledger_id` and `proposed_quantity` per row:
  `docs/audits/cogs-gap-tier1-repair-plan-2026-05-17.csv` (status=tier1, excluding the 5 canary SKUs)
- Approved approach when ready:
  1. Pre-repair snapshot of all 114 ledger rows
  2. Single `BEGIN`/`COMMIT` with 114 `UPDATE inventory_ledger SET quantity = <proposed_quantity> WHERE id = <ledger_id>`
  3. 114 scoped `POST /api/data/fifo?sku=<sku>` calls — NOT a full recalc
  4. Post-repair verification + execution record committed before declaring done

### Do NOT
- Re-run the canary (already done)
- Run `POST /api/data/fifo` without a `?sku=` param (full recalc is harder to audit)
- Touch MFN UI code in the same session as COGS repair

---

## Guardrails Confirmed (as of this session)

- SP-API writes: none made
- Orders / FBA / labels: untouched
- Schema: untouched
- `inventory_ledger.quantity_remaining`: untouched (FIFO left it at 0 for all 5 canary lots)
- `inventory_ledger.quantity`: **updated for 5 canary lots only** (ids 44704, 44733, 44633, 44827, 44585)
- `order_items.cogs_per_unit`: **updated for 23 canary order_items only** (by scoped FIFO)
- All other `inventory_ledger` and `order_items` rows: untouched

---

## 2026-05-29 — Buy-list CSV import into batches (InventoryLab-style)

Feature: from a batch (MFN or FBA), upload a buy-list CSV and bulk-add items in
one go, alongside (never replacing) the one-by-one add flow. Mirrors
InventoryLab's import: upload → map columns → validate → resolve existing
inventory → commit.

### Files changed (UNCOMMITTED — working tree only)
- `src/lib/imports/airtable-buylist.ts` (NEW) — column-mapped parser. Reads
  explicit ASIN/MSKU/Qty/Cost/List/Supplier/Date/Condition/Template columns
  (NOT SKU-encoded like the InventoryLab parser). Reuses `splitCsv()` and the
  Airtable header aliases. Auto-detects headers; caller can override per field.
- `src/app/api/list/batches/[id]/import/preview/route.ts` (NEW) — read-only
  parse + per-row existing-inventory flags (existsBySku/existsByAsin via
  merchant_listings + inventory_ledger) + duplicate-in-file detection.
- `src/app/api/list/batches/[id]/import/route.ts` (NEW) — bulk commit in ONE
  transaction, channel-aware: MFN → inventory_ledger lots tagged batch_id (like
  import-inventorylab); FBA → lot (no batch_id) + listing_batch_items linked via
  inventory_ledger_id (like items/route.ts). Always creates a fresh lot per row
  (buy-list = new purchase); per-row replenish/create-new only sets listing_mode
  for FBA. FIFO recalc scoped per affected SKU. Batch must be draft.
- `src/app/list/[id]/import/page.tsx` (NEW) — wizard UI (upload, editable column
  mapping, server-validated preview, per-row skip + FBA replenish/new select).
- `src/app/list/[id]/page.tsx` (EDIT) — added `FileUp` import + an "Import Buy
  List" link in both the MFN header and FBA actions, gated on status==='draft'.
  No other logic touched.

### Verification run
- `npx tsc --noEmit`: clean (0 errors).
- Live-DB schema check: every column written exists on inventory_ledger /
  listing_batch_items; merchant_listings has asin+sku; suppliers.name is UNIQUE
  (so INSERT OR IGNORE is safe).
- Runtime endpoint/UI test: NOT YET RUN — the running server is a prod
  `next-server` build without these new routes; needs pm2 stop → npm run build →
  pm2 start (deploy rule) before it can be exercised.

### Risk notes
- No SP-API writes. No schema changes. No migrations. Orders/labels untouched.
- Commit endpoint requires batch.status==='draft'; rejects rows with errors and
  duplicate MSKUs within the file before any write. All-or-nothing transaction.
- Divergence from items/route.ts REPLENISH semantics is intentional and
  documented in the route header (buy-list always records a new lot).
