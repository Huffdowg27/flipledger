# Claude Report — MFN Visual Polish + COGS Audit Checkpoint

_Last updated: 2026-05-17. Covers commits 28f2efa through 09991e9._

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
