# P&L Reconciliation Handoff — FlipLedger vs InventoryLab

**Audit period:** 2026-04-11 through 2026-05-11
**Last updated:** 2026-05-12
**Status:** FBAInboundConvenienceFee fix applied and verified. Remaining gap +$191.84 (FL above IL).

---

## Current reconciled state (as of 2026-05-12)

| Metric | Value |
|---|---|
| FL Reconciled net profit | **$3,205.58** |
| IL Reconciled net profit | $3,013.74 |
| Gap | **+$191.84 (FL above IL)** |
| Audit window | 2026-04-11 to 2026-05-11 |

---

## Fix history

### Fix 1 — ServiceFeeEvent query-time filter (applied, prior session)

Five fee types that appear in both `ServiceFeeEvent` (re-inserted daily by sync) and `SettlementServiceFee` (canonical, once per period) were excluded from the `serviceFees` query at read time.

**Filter applied in `profitloss/route.ts` and `dashboard/route.ts`:**
```sql
AND NOT (
  fe.event_type = 'ServiceFeeEvent'
  AND fd.fee_type IN (
    'FBAStorageFee',
    'FBARemovalFee',
    'Subscription',
    'FBACustomerReturnPerUnitFee',
    'FBAInboundTransportationFee'
  )
)
```

These five types still have their settlement-canonical counterparts counted correctly via `SettlementServiceFee`.

---

### Fix 2 — FBAInboundConvenienceFee dedup (applied 2026-05-12)

#### Root cause
`FBAInboundConvenienceFee` is an FBA inbound split-shipment fee charged per-unit per shipment plan. It arrives via `ServiceFeeEvent` with no `PostedDate`. `processServiceFeeEvent` in `finances.ts` used the sync's `contextDate` (today − 14 days) as the posted_date. Since `contextDate` advances daily, each sync run re-inserted the same fee with a new date, bypassing the existing dedup key `(fee_type, amount, asin, sku, date)`.

This fee has **no `SettlementServiceFee` equivalent** — it is never settled and cannot be excluded by the query-time filter. It had to be fixed at the sync layer.

#### Code fix — commit `bfa0b22`
`processServiceFeeEvent` in `src/lib/sp-api/finances.ts` now uses a two-branch dedup:

- **Events with `AmazonOrderId`** (FBA shipment plan fees): dedup by `(fee_type, shipment_id, amount)` via a `JOIN` on `fee_details + financial_events`. Skips insertion if that combination already exists — regardless of date.
- **Events without `AmazonOrderId`** (storage, subscription, etc.): unchanged — existing date + batch-count dedup path.

#### Historical data cleanup (run 2026-05-12)
**DB backup before cleanup:**
`data/backups/flipledger-before-fba-inbound-convenience-cleanup-20260512-120839.db`

**Cleanup preview CSVs (do not delete):**
- `docs/fba_inbound_convenience_fee_duplicate_cleanup_preview.csv`
- `docs/fba_inbound_convenience_fee_duplicate_backup.csv`

**Keep rule:** earliest `fee_detail_id` per `(fee_type, shipment_id, amount)` — the first time each unique fee was stored. Later rows are re-insertions from subsequent sync runs and belong to the period the shipment plan was originally created, not the re-sync date.

**Cleanup result:**

| | Before | After |
|---|---|---|
| All-time `FBAInboundConvenienceFee` rows | 3,700 | 1,499 |
| `fee_details` rows deleted | — | 2,201 |
| Orphaned `financial_events` rows deleted | — | 2,201 |
| Apr 11–May 11 rows | 525 | 20 |
| Apr 11–May 11 fee total | $1,125.87 | $68.91 |
| FL Reconciled net | $2,148.62 | **$3,205.58** |
| Gap vs IL | −$865.12 | **+$191.84** |

**Important — why $68.91, not $147.29 (earlier estimate):**
57 unique `(shipment_id, amount)` combos appear in the Apr 11–May 11 window. Of those:
- 20 had their first-ever insertion inside the window → $68.91 stays in Apr P&L
- 37 had their first insertion before Apr 11 → those fees correctly land in their original earlier period (not Apr 11–May 11)

The $147.29 estimate was wrong because it counted the "best row within window" for all 57 combos, rather than honouring the true first-insertion date.

---

## Fees confirmed clean — do not touch

### FBAInboundPlacementServiceFee
- Source: `SettlementServiceFee` only
- 77 rows in window, $178.15
- No duplication detected (each row is unique per settlement)
- **Leave as-is.**

### FBAInboundTransportationFee / InboundTransportationFee
- `ServiceFeeEvent` version correctly excluded by query-time filter
- `SettlementServiceFee` version (`InboundTransportationFee`, $14.97) counted once
- **Leave as-is.**

### MISSING_FROM_INBOUND_CLAWBACK / COMPENSATED_CLAWBACK
- Both from `SettlementServiceFee`, one row each, settlement-backed
- **Leave as-is.**

---

## Remaining gap — +$191.84 (FL above IL)

After cleanup FL is $191.84 *above* IL. Possible causes — do not chase yet:

- Refund timing differences (IL may count refunds differently)
- Small fee classification differences
- IL-specific treatment of clawback fee types
- FBA shipping credit handling

**Decision: defer investigation unless gap matters for filing.**

---

## Pending work (do not start until gap investigation is approved)

### COGS lot quantity correction

`inventory_ledger` was imported from IL's FBA Sales CSV which reports units *sold* per export window, not units *purchased*. MSKU position 4 (0-indexed, `_`-split) encodes true purchase quantity. Lots with `quantity_remaining=1–14` deplete after the first few sales; subsequent orders get `cogs_per_unit = 0`.

- 168 orders in window have `cogs_per_unit = 0`
- Estimated missing COGS: ~$1,480.17
- **Do not apply until approved.** Run dry-run preview first.

**MSKU parsing:**
```typescript
function parseMskuQty(sku: string): number {
  const parts = sku.split('_');
  return parseInt(parts[4]);  // position 4 = purchase quantity
}
function parseMskuCost(sku: string): number {
  const parts = sku.split('_');
  return Math.round(parseFloat(parts[3]) * 100);  // position 3 = buy price in dollars
}
```

---

## Next product step — reporting-view architecture

Three planned P&L view modes:

| Mode | Basis | Purpose |
|---|---|---|
| **Operating / Sellerboard-style** | Posted date, all fees including estimated | Day-to-day operations, velocity, margin by product |
| **Cash / DD+7** | Posted date + Amazon reserve release timing | Cash flow forecasting, actual bank deposit view |
| **Accounting / Reconciled** | Settlement-period fees only (`financial_event_id != 0`) | Tax filing, IL comparison, true settled P&L |

This is the next architectural decision — do not implement until approved.

---

## Debug endpoints (all read-only)

| Endpoint | Purpose |
|---|---|
| `/api/debug/recon?startDate=&endDate=` | 3-mode recon: Accrual vs IL Estimated, Cash vs IL Reconciled, DD+7 |
| `/api/debug/sales-gap?startDate=&endDate=` | Bucket analysis: FL Accrual, FL Cash, Held, Prior-period |
| `/api/debug/cogs-gap?startDate=&endDate=` | Zero-COGS breakdown, MSKU lot qty mismatch table |
| `/api/debug/fee-double-count?startDate=&endDate=` | Per-pair analysis, day-repetition proof, impact summary |
| `/api/debug/settlement-periods?requestedStart=` | Settlement period metadata, overlap groups, effective start |

---

## IL target numbers (from CSVs imported 2026-05-11)

### IL Estimated (include estimated ON)
```
Sales:            $45,177.78
COGS:             $22,994.55
Amazon Ref Fee:   $ 6,644.11
FBA Fulfill Fees: $ 4,521.20
Net Profit:       $ 7,521.89
```

### IL Reconciled only
```
Sales:            $28,554.85
COGS:             $14,336.35
Amazon Ref Fee:   $ 4,150.51
FBA Fulfill Fees: $ 3,529.76
Net Profit:       $ 3,013.74
```

---

## Settlement periods

- `settlement_periods` table populated via `/api/sync/backfill-settlement-periods`
- 29 periods stored, all dates normalized to ISO format
- `getEffectiveReconcileStart` helper in `reports.ts`: finds earliest settlement period ≥ requested start date, tie-breaks on shortest duration
- Settlement-aware start snap was tested for 2026-04-11: zero orders excluded (all Apr 11 orders post after 15:10:36 UTC). **Not the source of the gap.**
