# P&L Reconciliation Handoff — FlipLedger vs InventoryLab

**Audit period:** 2026-04-11 through 2026-05-11  
**Session date:** 2026-05-11  
**Status:** Bugs confirmed, fixes designed, NOT YET applied

---

## Summary of findings

Three root causes explain the full divergence between FlipLedger and InventoryLab:

| # | Bug | FL vs IL gap | Fix status |
|---|-----|-------------|------------|
| 1 | Fee double-count (5 fee types) | −$1,487.43 (FL overcounts fees) | Fix designed, NOT applied |
| 2 | COGS lot quantity understatement | −$1,480.17 (FL undercounts COGS) | Fix designed, NOT applied |
| 3 | Date-basis mismatch (Accrual vs IL Hybrid) | $8,141.27 sales / $4,460.17 COGS | By design — future IL Hybrid mode planned |

---

## Mode decision (CONFIRMED)

**Do NOT change FL Accrual to match IL.** Keep FL Accrual pure (purchase_date basis).

Four planned dashboard modes:
1. **Accrual** — purchase_date basis (current default) ← keep this pure
2. **Cash/Reconciled** — ShipmentEvent posted_date basis
3. **InventoryLab Hybrid** — settled orders by posted_date + unreconciled by purchase_date ← future work
4. **DD+7 Forecast** — held cash + expected release timing ← future work

---

## Bug 1: Fee double-count (Part 1 fix — NEXT to apply)

### Root cause
`ServiceFeeEvent` rows are re-inserted every sync day (new `posted_date` bypasses the unique constraint). The same fee ends up with N rows — one per sync day that overlaps its window. `SettlementServiceFee` is the canonical single-source; it never re-inserts.

The `serviceFees` query in `profitloss/route.ts` and `dashboard/route.ts` joins `fee_details` to `financial_events` with NO filter on `event_type`, so both ServiceFeeEvent and SettlementServiceFee rows are summed.

### Confirmed duplicate pairs

| ServiceFeeEvent fee_type | SettlementServiceFee | IL bucket | Overcount |
|--------------------------|---------------------|-----------|-----------|
| FBAStorageFee | StorageFee | 30 Day Storage Fees | $700.15 (5× repetition) |
| FBARemovalFee | RemovalComplete | Removal Order Fees | $174.79 |
| Subscription | SubscriptionFee | Amazon Pro Subscription | $159.96 |
| FBACustomerReturnPerUnitFee | FBACustomerReturnPerUnitFee | FBA Customer Return Per Unit Fee | $304.64 |
| FBAInboundTransportationFee | InboundTransportationFee | Inbound Transportation Fee | $147.89 |
| **Total** | | | **$1,487.43** |

### Fee types that must NOT be excluded (ServiceFeeEvent only, no settlement equivalent)
- `FBAInboundConvenienceFee`: −$958.78 — only source
- `ReCommerceGradingAndListingCharge`: −$9.00 — only source

### Fix: Part 1 — query-time filter (SAFE, no data changes)

Add to the WHERE clause of all 4 `serviceFees`-style queries:

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

Files to edit:
- `src/app/api/data/profitloss/route.ts` — `serviceFees` query (~line 123)
- `src/app/api/data/dashboard/route.ts` — `serviceFeeData`, `prevServiceFeeData`, `serviceFeeBreakdown` queries

### Fix: Part 2 — sync idempotency (DEFER — 3 options)
Options:
1. Content hash dedup: add a hash column to financial_events; skip insert if hash exists
2. ±14-day dedup: when syncing ServiceFeeEvents, delete existing rows within a window before reinserting
3. SettlementServiceFee-preferred: after sync, delete any ServiceFeeEvent rows that have a matching SettlementServiceFee counterpart

**Recommendation:** Option 3 is cleanest — mirrors the query-time fix at the data layer.

---

## Bug 2: COGS lot quantity understatement

### Root cause
`inventory_ledger` was imported from IL's FBA Sales CSV which reports units *sold* per export window, not units *purchased*. MSKU position 4 (0-indexed, `_`-split) encodes the true purchase quantity. Lots with `quantity_remaining=1–14` deplete after the first few sales; all subsequent orders of that SKU get `cogs_per_unit = 0`.

### Confirmed impact
- 168 orders in the date range have `cogs_per_unit = 0`
- Estimated missing COGS: ~$1,480.17
- Of those, some have zero COGS because the lot was legitimately depleted; others have wrong lot quantities

### MSKU qty parsing
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

### Fix: lot quantity dry-run (NOT YET DONE)
Before any writes, build a preview table:
`(MSKU, current qty, parsed qty from position 4, buy_price, date_purchased, units_sold, proposed_new_qty, confidence)`

Then re-run FIFO after confirming the preview looks correct.

---

## Bug 3: Date-basis mismatch (by design)

### Finding
IL "Estimated" P&L is a **hybrid**: settled orders use `ShipmentEvent.posted_date`; unreconciled orders use `purchase_date`. FL Accrual uses `purchase_date` for all orders.

168 prior-period orders (purchased before 2026-04-11, settled in the window) account for:
- $8,453 of the sales gap
- $4,460 of the COGS gap

This is not a bug — it's a mode difference. The fix is to build the "InventoryLab Hybrid" mode.

---

## Debug endpoints (all read-only, no data writes)

| Endpoint | Purpose |
|----------|---------|
| `/api/debug/recon?startDate=&endDate=` | 3-mode recon: Accrual vs IL Estimated, Cash vs IL Reconciled, DD+7 |
| `/api/debug/sales-gap?startDate=&endDate=` | Bucket analysis: FL Accrual, FL Cash, Held, Prior-period |
| `/api/debug/cogs-gap?startDate=&endDate=` | Zero-COGS breakdown, MSKU lot qty mismatch table |
| `/api/debug/fee-double-count?startDate=&endDate=` | Per-pair analysis, day-repetition proof, impact summary |

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

## Next session checklist

1. **Apply Part 1 query-time fee filter** to profitloss + dashboard routes
2. Rebuild (`npm run build`) and restart PM2 (`pm2 restart 5`)
3. Re-run `/api/debug/recon?startDate=2026-04-11&endDate=2026-05-11` — verify storage/removal/subscription buckets corrected
4. Run COGS lot quantity dry-run (build preview table, no writes yet)
5. Confirm preview → apply lot quantity corrections → re-run FIFO
6. Re-run full recon audit
7. Decide: implement IL Hybrid mode (Mode 3) or move to next priority

---

## Schema notes (for future IL Hybrid mode)

```sql
-- Cash basis: ShipmentEvent posted_date
SELECT order_id, MIN(posted_date) as posted_date
FROM financial_events WHERE event_type = 'ShipmentEvent' AND order_id IS NOT NULL
GROUP BY order_id

-- IL Hybrid: settled orders by posted_date, unreconciled by purchase_date
-- Reconciled = has a ShipmentEvent in financial_events
-- Unreconciled = purchase_date only, no settlement yet
```
