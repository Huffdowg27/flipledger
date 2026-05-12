# FBA Shipment Workflow — Handoff Document

Last updated: 2026-05-06

---

## 1. Current Working Status

| Feature | Status |
|---|---|
| Existing MSKU replenishment detection | Working — scans Seller Central after every ASIN scan, shows composite status labels, strict auto-select |
| Batch creation | Working |
| Boxing (setPackingInformation) | Working — dimensions now sent as `IN` (not `CM`), weight in `LB` |
| Placement option generation & confirmation | Working |
| Transportation option generation & confirmation | Working |
| Delivery window confirmation (non-partnered) | Working — auto-confirmed, 403 treated as no-op |
| Seller Central unlock (listing goes live) | Working |
| Box labels (PDF download) | Working |
| FNSKU labels (Avery 5160 30-up PDF) | Working |
| REPLENISH_EXISTING mode (skip listing PUT) | Working — bypasses 10-15min publication wait |

---

## 2. Confirmed Successful Test Batches

**Batch 7**
- 5 shipments confirmed in Seller Central
- UPS partnered carrier, estimated carrier charges: $85.01
- Seller Central fully unlocked

**Batch 8 (QA test — Workflow ID: wf8f84729e-8912-4784-9df7-177f72c76467)**
- Track shipment: FBA19CV8KZZ9 — GEU3
- Clean restart test
- Placement confirmed, transportation confirmed, Seller Central unlocked
- Labels generated
- Created: 2026-05-07T04:56:35, Last updated: 2026-05-07T04:59:16

---

## 3. Known Critical Bugs

### 3a. Seller Central "Invalid Date - Invalid Date" for expected delivery week
- **Symptom**: Seller Central shows "Expected delivery week: Invalid Date - Invalid Date"
- **Root cause**: Not yet confirmed. Delivery window option dates come from Amazon — we just confirm `deliveryWindowOptionId`. May be Amazon returning null date fields in the window option, or a Seller Central display issue.
- **Debug added**: Full delivery window option object now logged in PM2 before confirmation (`[deliveryWindow] all options for ...`). Check PM2 logs on next run to see what Amazon sends back.
- **Not fixed yet.**

### 3b. Box dimensions showed 15.2 × 15.2 × 15.2 in Seller Central
- **Root cause**: `setPackingInformation` was sending `unitOfMeasurement: 'CM'` with inch→CM converted values (user enters 6 in → code sent 15.24 → Seller Central displayed "15.2 inches" because it ignored the unit field).
- **Fix applied** (2026-05-06): Changed to `unitOfMeasurement: 'IN'`, removed `* IN_TO_CM` conversion. Now sends raw inch values. Full box payload is console-logged before each API call.
- **Needs verification on next real shipment.**

### 3c. Carrier cost not reliably persisted/displayed across all shipments
- Transportation confirmation saves cost from `opt.quote.cost.amount`. If the option object doesn't carry quote data at confirm time (because it came from a stale `selectedOptions` array), cost may be null.
- Not yet fixed — low severity for current workflow.

### 3d. Map does not show final destinations
- Shipment destination data is saved post-confirmation in `confirmed_shipments` JSON column.
- Pre-confirmation, FC destination may not be available from Amazon (the API returns destination only after placement is confirmed and sometimes only after transportation is confirmed).

---

## 4. Current Rule

**Do not touch the core placement/transport/label API flow unless a regression appears.**

The sequence `createInboundPlan → setPackingInformation → confirmPackingOption → generatePlacementOptions → confirmPlacementOption → generateTransportationOptions → confirmTransportationOptions` is working end-to-end. Do not refactor it.

---

## 5. Next Priority: Data Integrity Verification

After the dimension unit fix (3b above), verify on next real shipment:
1. Box dimensions in Seller Central match what user entered (in inches)
2. Box weight in Seller Central matches (in lb)
3. Expected delivery week shows valid dates (and check PM2 logs for delivery window option payload to debug 3a)
4. Transportation carrier and cost display correctly

If all pass: the core workflow is production-ready.

---

## 6. Future Feature Backlog (do not implement without explicit user direction)

- Duplicate box / bulk identical boxes UI
- FBA inventory replenishment page (view existing FBA stock, create replenishment batches)
- Bin / location notes per item
- Map destination polish (show FC cities on confirmation map)
- Shipping quote display polish (show per-shipment carrier cost breakdown)
- Better completed-shipment dashboard (historical P&L per batch)

---

## 7. Regression Checklist (run after any API or send flow change)

1. Add existing Seller Central MSKU (REPLENISH_EXISTING mode) — should skip listing PUT and immediately have FNSKU
2. Add new ASIN (CREATE_NEW mode) — should create listing, wait for FNSKU, proceed
3. Create batch, add item, set box dimensions + weight
4. Generate placement options
5. Confirm placement (auto-confirm or manual select)
6. Confirm transportation (verify carrier/cost shown)
7. Verify Seller Central shows shipment as "Working" and is unlocked
8. Download box labels (PDF)
9. Download FNSKU labels (Avery 5160 30-up PDF)
10. **Spot-check in Seller Central**: dimensions match input, weight matches, delivery week shows valid dates, destination FC shown, carrier cost shown

---

## 8. Key File Map

| File | Purpose |
|---|---|
| `src/lib/sp-api/inboundPlansV2.ts` | All Inbound v2024 API calls (packing, placement, transportation, labels) |
| `src/lib/sp-api/listingsItems.ts` | Listings Items API (create/update listing, getListingsForASIN) |
| `src/app/api/list/batches/[id]/send/route.ts` | Phase 1: create listings, wait for FNSKU, create inbound plan |
| `src/app/api/list/batches/[id]/transportation/route.ts` | Phase 3.5: generate/confirm transportation + delivery windows |
| `src/app/api/list/batches/[id]/status/route.ts` | Status polling — 15min timeout, per-item debug, force-ready |
| `src/app/api/list/catalog/existing-skus/route.ts` | Lookup existing Seller Central MSKUs for an ASIN |
| `src/app/list/[id]/page.tsx` | Main batch UI — scanning, boxing, send flow, status card |
| `src/lib/db.ts` | Schema + migrations (listing_batch_items has listing_mode, fnsku columns) |

---

## 9. SP-API Notes (hard-won, do not lose)

- `filterASINs` on `GET /listings/2021-08-01/items/{sellerId}` is unreliable — Amazon ignores it. Always filter client-side on `summary.asin`.
- `setPackingInformation` requires `unitOfMeasurement: 'IN'` with raw inch values. Do not convert.
- For FBA listings: do NOT pass `quantity` in `fulfillment_availability` — Amazon rejects with ATTRIBUTE_SUPPRESSED.
- `skip_offer: false` is required for FNSKU generation. Without it, no offer is created, no FNSKU, inbound plan fails.
- `start_at` is required in `purchasable_offer` for BUYABLE transition — without it the listing stays DISCOVERABLE.
- `confirmDeliveryWindowOptions` returning 403 is normal for some account/shipment types — treat as no-op.
- `readyToShipWindow.start` in `generateTransportationOptions` is always set (fallback = tomorrow noon UTC if blank).
- DISCOVERABLE status = OOS FBA listing, still valid and replenishable — not the same as INACTIVE.
