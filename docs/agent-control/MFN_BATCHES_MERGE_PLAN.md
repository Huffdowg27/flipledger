# MFN Receive → Batches Merge — Safe Route-Bridge Plan

_Plan only. No code changes. Authored 2026-05-18._

This plan answers the seven questions from `NEXT_CLAUDE_TASK.md` and ends with a
concrete, minimal first commit that makes `/api/list/batches/[id]/items` safe
for `listingMode='REPLENISH_EXISTING'` on MFN listings. UI is **not** touched
in the first commit.

---

## 0. Current state — what's actually wired

Verified by reading the files in the task's "Read first" list:

- `listing_batch_items.inventory_ledger_id INTEGER` already exists in the
  schema (`src/lib/db.ts:652`, added via the migration block). **No code path
  populates or reads it yet.** That's the unused bridge column.
- `POST /api/list/batches/[id]/items` (`route.ts:109-128`):
  - Reads `inventory_ledger WHERE sku = ?` (no `quantity_remaining > 0`
    filter; no condition filter; picks any existing row).
  - If a row exists: **overwrites `buy_price`** with the new buy price,
    `quantity += new`, `quantity_remaining += new`, `date_purchased`
    overwritten via `COALESCE(?, date_purchased)` with the request's
    `purchaseDate` (or `now` if absent) — i.e. `purchaseDate || now` is
    always truthy, so the column **is always overwritten**.
  - Always calls `recalculateFIFO({ sku })`.
- `DELETE /api/list/batches/[id]/items/[itemId]` (`items/[itemId]/route.ts:170-195`):
  - On removing a draft batch item, **decrements `inventory_ledger.quantity`
    and `quantity_remaining` by the item's quantity**, and deletes the lot row
    if both reach zero.
  - Then recalculates FIFO.
- `PATCH /api/list/batches/[id]/items/[itemId]` does **not** touch
  `inventory_ledger` (comment at line 7 confirms). Good — leave it that way.
- `POST /api/data/inventory-lots/create-mfn-local-lot` is already safe-by-design:
  - Guard: if a row exists for `sku` with `quantity_remaining > 0`, returns
    the existing lot, sets `existingLotUsed: true`, **does not insert or
    mutate anything**.
  - Only inserts a fresh lot when none with remaining stock exists.
  - This is the existing "safe MFN create" path the `/mfn/batch` page uses.
- `mfn-search` joins `merchant_listings` to the **newest non-empty lot per SKU**
  (`route.ts:120-128`). The "lot id" surfaced into `/mfn/batch` rows is this
  joined `il.id`.

### The unsafe behaviors for MFN REPLENISH

For an MFN listing that already has real on-hand inventory (the normal
replenish case), the current `/list/[id]` add flow will:

1. **Silently mutate `buy_price`** of the long-standing lot — destroying
   historical cost. FIFO will then mis-cost all future sales from that lot
   and (because `recalculateFIFO` walks history) can re-cost **past** sales
   too. This is the highest-severity bug.
2. **Overwrite `date_purchased`** on the existing lot, shifting it to "today"
   in FIFO ordering. Combined with (1), this scrambles cost history.
3. **Roll the `quantity_remaining` decrement on DELETE through real on-hand
   inventory** — if the user adds an MFN replenish item to a batch and then
   removes it (very normal during drafting), the route will subtract those
   units from real merchant inventory. Worst case: a multi-step "add by
   mistake → remove → re-add with corrected qty" sequence permanently
   under-counts MFN stock.

(The FBA `CREATE_NEW` path that this route was written for is correct,
because for a brand new SKU there is no prior lot to corrupt. The bug is
MFN-replenish-specific.)

---

## 1. How should MFN `REPLENISH_EXISTING` batch items link to `inventory_ledger_id`?

**One-to-one row reference, populated at POST time, used by DELETE.**

- Add `inventory_ledger_id` to the POST insert into `listing_batch_items`.
  For MFN replenish, this points at the lot row the units were added to (or
  the existing lot that absorbed the qty, if we choose the reuse branch).
- For `CREATE_NEW` (FBA today, and brand-new MFN listings), it points at the
  freshly inserted lot row created during the same transaction.
- For `REPLENISH_EXISTING` MFN, it points at the existing lot row that
  represents the seller's current on-hand stock for that SKU.

This single column does all the work the bridge needs. No new table.

Why one-to-one is enough: a batch item already represents "this many units
of this SKU, added to inventory at this buy price." It maps cleanly onto a
single lot. Splitting one batch item across multiple lots would require a
junction table — out of scope, and not needed for the replenish flow today.

---

## 2. When should the route reuse an existing lot vs create a guarded new one?

Decided by `listingMode` sent by the client:

| listingMode | Behavior |
|---|---|
| `CREATE_NEW` | Always **insert** a new `inventory_ledger` row in the same transaction. Never read or mutate prior lots. (This is what new FBA items and brand-new MFN listings need.) |
| `REPLENISH_EXISTING` | **Reuse** the newest existing lot with `quantity_remaining > 0` for that SKU. Do **not** mutate `buy_price` or `date_purchased`. Do **not** increment `quantity` or `quantity_remaining`. Treat the batch item as a logical "pending receive" — the actual on-hand stock is whatever Amazon already shows; no new units exist until the seller physically receives. |

Wait — but in `/mfn/batch` today, the user **does** create new inventory when
they bring in fresh purchase units to replenish an existing listing. How does
the existing safe path handle that?

Looking at `create-mfn-local-lot`: when an existing lot with remaining qty
exists, it **returns that lot unchanged** and does nothing else. The
`/mfn/batch` page then uses `PATCH /api/data/inventory-lots` to set
`quantity_received`, `bin_location`, etc. — but **does not change `quantity`
or `quantity_remaining`** (the PATCH route only updates those if the request
explicitly sends `quantity`, which `/mfn/batch` does not).

So the existing safe pattern is:

> **For MFN replenish, do not auto-grow `quantity_remaining` on add. The
> seller's actual receive event grows it through a separate explicit step
> (or not at all if the workflow is just listing more of what's there).**

This plan adopts the same rule. The `listing_batch_items` row records intent
("I want this many more units listed at this buy price"); the actual
`inventory_ledger` mutation that adds units happens only through an explicit,
reviewed receive action, not as a silent side-effect of POSTing a batch item.

For Commit 1, that means: **MFN replenish POSTs link to the existing lot via
`inventory_ledger_id` and do NOT touch any lot column.** The buy price the
user typed is preserved on the batch item itself (`buy_price_cents` already
exists on `listing_batch_items`). It will be carried forward to a real lot
only when the receive flow runs later — that work is Commit 2+.

---

## 3. How do we avoid double-creating inventory?

Three rules:

1. **`listingMode` strictly gates which branch runs.** `REPLENISH_EXISTING`
   never inserts. `CREATE_NEW` always inserts. There is no implicit branch.
2. **For `REPLENISH_EXISTING`, look up the lot once at the start of the
   transaction and either link or fail.**
   - Query: newest `inventory_ledger` row where `sku = ?` and
     `quantity_remaining > 0` (mirrors `create-mfn-local-lot`'s guard).
   - If none found → return 409 with a clear error. Do **not** silently
     fall back to insert. Client must either switch to `CREATE_NEW` or run
     the existing "create local lot" path on `/mfn/batch`.
3. **For `CREATE_NEW`, the insert lives inside the same `db.transaction`
   as the `listing_batch_items` insert**, and the new lot id is written to
   `listing_batch_items.inventory_ledger_id` in that same transaction.
   No two-step "insert lot, then maybe fail and orphan it" window.

Idempotency note: nothing about this flow requires being idempotent across
retries (each user click creates one batch item). The transaction boundary
is enough.

---

## 4. How do we prevent delete/cascade from decrementing real MFN inventory incorrectly?

**Behavior split by mode, keyed on `inventory_ledger_id` + an "owned by this
item?" check:**

```
on DELETE listing_batch_item:
  if listing_mode == 'CREATE_NEW':
    # current behavior: rollback the ledger row this item created
    decrement il.quantity and il.quantity_remaining by item.quantity
    if both reach 0 → delete the lot row (it was created by this item)
  elif listing_mode == 'REPLENISH_EXISTING':
    # do NOT touch inventory_ledger.
    # the linked lot represents real on-hand stock that pre-existed this batch item.
    just delete the listing_batch_item row.
```

**Why this is safe:**

- `CREATE_NEW` items truly own their lot row (it was inserted at add time,
  in the same transaction). The existing rollback is correct for them.
- `REPLENISH_EXISTING` items do **not** own their lot row. The lot existed
  before the batch item was created, represents real merchant inventory, and
  was never grown by the POST (per §2). So DELETE leaves it untouched.

**Stronger guarantee (optional but recommended for Commit 1):** before doing
the `CREATE_NEW` decrement, also verify that the linked lot's
`quantity == quantity_remaining` and that no FIFO consumption has occurred —
i.e. the lot really is "untouched since creation." If consumption has
happened (rare, but possible if a sale settled between add and remove),
**fail closed** with a clear error rather than risk a wrong decrement. The
user can resolve via the inventory-lots admin path.

ON DELETE CASCADE on the FK from `listing_batch_items.batch_id` →
`listing_batches(id)` is not affected by any of this (it just removes the
items when the parent batch is deleted). But the same logic above is what
needs to run **for each item** when a draft batch is deleted. That means
the batch-delete route, if it deletes draft items, also needs to honor the
mode-split rollback. (Verify in Commit 1 whether the batch-delete route
exists and what it does — if it relies on `ON DELETE CASCADE` to wipe
items silently, that's already a quiet-rollback bug for any batch with
items in it; this work fixes it on the item route first and the batch
route can follow.)

---

## 5. Which fields stay on `inventory_ledger` vs `listing_batch_items`?

Guiding principle: **`inventory_ledger` is the source of truth for COGS and
physical stock; `listing_batch_items` records listing intent within a batch.**
Duplicating a value is fine when one belongs on the other for a different
reason; mutating across the boundary is not.

| Concept | Lives on | Notes |
|---|---|---|
| Buy price (cost) | `inventory_ledger.buy_price` | Authoritative for FIFO. Never overwrite an existing lot's buy_price from a batch POST. |
| Buy price the **user typed for this batch item** | `listing_batch_items.buy_price_cents` | Already exists. Useful for audit / "what did they intend." For `CREATE_NEW`, the two values match by construction. For `REPLENISH_EXISTING` they may differ; this is fine — the canonical cost remains the lot's. |
| Quantity to **list** | `listing_batch_items.quantity` | What the user wants Amazon's listing to show / what they're prepping for the batch. |
| Quantity **on hand** | `inventory_ledger.quantity` and `quantity_remaining` | Physical reality. Only grows via explicit receive, never via batch add for replenish. |
| `inventory_ledger_id` link | `listing_batch_items.inventory_ledger_id` | The bridge. |
| `bin_location`, `condition`, `merchant_shipping_group_name`, `list_price_cents`, `received_at`, `inspected_at`, `quantity_received` | `inventory_ledger` (already do) | These are receive-flow / physical-state attributes; they belong with the lot. `/mfn/batch` already PATCHes these via `inventory-lots`. The batch-items route should not write them. |
| `listing_mode`, `fnsku`, `fulfillment_channel`, `listing_source`, `amazon_inventory_status`, `listing_status`, `labels_printed_at` | `listing_batch_items` (already do) | Listing-tool / SP-API workflow state. |
| `purchase_date`, `supplier` | `listing_batch_items` (already stored), and used to seed the lot **only on `CREATE_NEW`** | For replenish, the lot's `date_purchased` is not changed. |
| Product name / image | `products` table (already de-duped via `ON CONFLICT(asin)`) | Unchanged. |

The net schema change for Commit 1 is **zero** — `inventory_ledger_id` already
exists. The migration is just "start populating it."

---

## 6. What exact tests/SQL verification prove no COGS/FIFO damage?

Before merging Commit 1, run these against `data/flipledger.db` on a backup
copy. The principle: take a snapshot before, run the modified flow, compare.

### Pre-test snapshot

```sql
-- A) Snapshot every lot's current state.
.headers on
.mode csv
.output /tmp/pre_lots.csv
SELECT id, sku, asin, buy_price, quantity, quantity_remaining,
       date_purchased, supplier_id, list_price_cents,
       bin_location, condition, merchant_shipping_group_name,
       received_at, inspected_at
FROM inventory_ledger
ORDER BY id;

-- B) Snapshot the cogs assignment on order_items.
.output /tmp/pre_cogs.csv
SELECT id, order_id, sku, asin, quantity, cogs_per_unit
FROM order_items
ORDER BY id;

-- C) Snapshot batch items.
.output /tmp/pre_batch_items.csv
SELECT id, batch_id, sku, asin, listing_mode, quantity,
       buy_price_cents, inventory_ledger_id, created_at
FROM listing_batch_items
ORDER BY id;
.output stdout
```

### Functional tests (manual, via API or UI)

For each, capture the response and re-snapshot lots + cogs.

1. **CREATE_NEW for a brand-new SKU.** Expect: one new lot row, batch item
   row references it via `inventory_ledger_id`, `recalculateFIFO` runs but
   only assigns the new lot to future events.
2. **CREATE_NEW for a SKU that already has lots.** Expect: a **new** lot row
   (not a merge), no mutation on existing lots' `buy_price` or
   `date_purchased`, batch item links to the new lot.
3. **REPLENISH_EXISTING for an MFN SKU with one existing lot, qty 5
   remaining.** Expect: zero lot rows changed in any column, batch item
   created with `inventory_ledger_id = <existing lot id>`.
4. **REPLENISH_EXISTING for an MFN SKU with no remaining inventory.**
   Expect: 409 error, zero rows changed anywhere, no FIFO recalculation.
5. **DELETE a `CREATE_NEW` item.** Expect: lot decremented or removed per
   existing behavior. FIFO recalculated. No other lot rows affected.
6. **DELETE a `REPLENISH_EXISTING` item.** Expect: **no `inventory_ledger`
   change at all.** Batch item row removed. FIFO recalculation may run as
   a no-op (still safe), or be skipped — either is acceptable, but skipping
   is preferred to keep the diff tight.

### Post-test invariants (SQL)

Run these after each test and confirm:

```sql
-- I1: No silent buy_price mutations. For every lot id, current buy_price
-- equals pre-test buy_price unless this test was supposed to create that lot.
SELECT pre.id, pre.buy_price AS pre_bp, post.buy_price AS post_bp
FROM pre_lots pre JOIN inventory_ledger post ON post.id = pre.id
WHERE pre.buy_price <> post.buy_price;
-- Expected: 0 rows.

-- I2: No silent date_purchased mutations.
SELECT pre.id, pre.date_purchased, post.date_purchased
FROM pre_lots pre JOIN inventory_ledger post ON post.id = pre.id
WHERE pre.date_purchased <> post.date_purchased;
-- Expected: 0 rows.

-- I3: For REPLENISH tests, quantity_remaining unchanged on the linked lot.
SELECT pre.id, pre.quantity_remaining, post.quantity_remaining
FROM pre_lots pre JOIN inventory_ledger post ON post.id = pre.id
WHERE pre.quantity_remaining <> post.quantity_remaining;
-- Expected after REPLENISH tests: 0 rows.
-- Expected after CREATE_NEW tests: rows only for the newly-created lot,
-- which won't appear in pre_lots at all, so this query still returns 0.

-- I4: cogs_per_unit on existing order_items is unchanged after REPLENISH tests
-- (since no lot was added/changed, FIFO has nothing new to assign).
SELECT pre.id, pre.cogs_per_unit, post.cogs_per_unit
FROM pre_cogs pre JOIN order_items post ON post.id = pre.id
WHERE pre.cogs_per_unit <> post.cogs_per_unit;
-- Expected after REPLENISH tests: 0 rows.

-- I5: Every batch item has either a valid inventory_ledger_id or NULL
-- (NULL only on pre-bridge legacy rows).
SELECT bi.id, bi.inventory_ledger_id
FROM listing_batch_items bi
LEFT JOIN inventory_ledger il ON il.id = bi.inventory_ledger_id
WHERE bi.inventory_ledger_id IS NOT NULL AND il.id IS NULL;
-- Expected: 0 rows.
```

### Build / HTTP smoke

Per `PRODUCT_GUARDRAILS.md` and `REVIEW_CHECKLIST.md`:

- `npm run build` clean.
- `GET /mfn/batch` → 200.
- `GET /analyze/merchant-inventory` → 200.
- `GET /list/<existing-batch-id>` → 200.
- `POST /api/list/batches/<draft>/items` exercised for both modes (above).

---

## 7. What should be implemented first, and what should explicitly wait?

### Commit 1 — first safe bridge (route-only, no UI)

**Scope (files):**

- `src/app/api/list/batches/[id]/items/route.ts` (POST handler)
- `src/app/api/list/batches/[id]/items/[itemId]/route.ts` (DELETE handler)

**Changes:**

1. POST: branch on `listingMode`.
   - `CREATE_NEW` path: keep the current behavior but **stop reading or
     touching prior lots for this SKU**. Always `INSERT` a new
     `inventory_ledger` row, in the same transaction; capture
     `lastInsertRowid`; write it to `listing_batch_items.inventory_ledger_id`.
     Stop doing the `existing` lookup + UPDATE branch entirely (it's the
     source of the buy_price overwrite bug).
   - `REPLENISH_EXISTING` path: look up the newest lot with
     `quantity_remaining > 0` for that SKU. If none, return 409 with a
     clear error. If found, **insert no lot, mutate no lot**; just insert
     the `listing_batch_items` row with `inventory_ledger_id = <found>.id`.
   - For both paths, `recalculateFIFO({ sku })` only needs to run when a
     lot was created — skip the call on `REPLENISH_EXISTING` to keep this
     commit's surface as small as possible.
   - Reject requests where `listingMode` is missing or not one of the two
     known values (defensive — surfaces client bugs immediately rather
     than picking a path silently).

2. DELETE: branch on the batch item's `listing_mode` (already stored on
   the row) and on whether `inventory_ledger_id IS NOT NULL`.
   - `CREATE_NEW`: current rollback behavior, but **additionally fail
     closed** if `quantity_remaining < quantity` on the linked lot (means
     FIFO already consumed from it — decrementing would corrupt history).
   - `REPLENISH_EXISTING`: do not touch `inventory_ledger`. Just delete
     the batch item row. Skip FIFO recalculation.

3. Use `inventory_ledger_id` for the rollback lookup, not the
   `WHERE sku = ?` lookup currently in the DELETE route. That removes the
   "two lots same SKU, decrement the wrong one" failure mode for
   `CREATE_NEW` deletes after this commit lands.

**Not in scope for Commit 1:**

- No schema migration (column already exists).
- No changes to `/list/[id]/page.tsx` UI.
- No changes to `/mfn/batch/page.tsx`.
- No changes to `create-mfn-local-lot` route.
- No changes to `inventory-lots` POST / PATCH / DELETE.
- No changes to PATCH `/api/list/batches/[id]/items/[itemId]` (it already
  leaves `inventory_ledger` alone).
- No change to SP-API push or activation preview payloads.
- No change to FBA send/boxing flow.
- No backfill of `inventory_ledger_id` on legacy rows — leave NULL.
  Legacy rows continue to work because the route only uses
  `inventory_ledger_id` on DELETE if it's non-NULL, and falls back to the
  current SKU-based path for older rows. (Decision to backfill later if
  needed.)

**Pre-commit checklist (matches `REVIEW_CHECKLIST.md`):**

- `git diff` only shows the two route files.
- Build clean.
- HTTP smokes pass (above).
- SQL invariants I1–I5 hold on a copy of the DB after running tests 1–6.
- Update `CLAUDE_REPORT.md` with files changed, behavior changed, risk
  notes, and the commit hash.

### Explicitly waits for Commit 2+

- **MFN replenish UI on `/list/[id]`.** Once the route is safe, the `/list/[id]`
  flow can be allowed to surface MFN search results and submit
  `listingMode='REPLENISH_EXISTING'`. Until then, treat `REPLENISH_EXISTING`
  on `/list/[id]` as backend-supported but UI-disabled.
- **Receive flow inside Batches.** The actual "I now physically have these
  units, grow `quantity_remaining`" step needs to come from an explicit
  receive action that mirrors what `/mfn/batch` does via the
  `inventory-lots` PATCH route. Wiring that into `/list/[id]` is its own
  reviewable commit and should follow the same "no buy_price overwrite,
  no date_purchased overwrite" rules.
- **SP-API activation preview/push from `/list/[id]`.** Out of scope until
  the receive flow is proven.
- **Visual polish of `/list/[id]` to match PSH brief.** Comes after
  behavior is correct, per the task's "do not jump into visual polish first."
- **Batch-delete rollback parity.** If the batch-level delete route
  cascades silently, fix it after the per-item route is proven correct.

---

## Summary

The bridge is already half-built in the schema: `inventory_ledger_id` exists
on `listing_batch_items` and is unused. Commit 1 is a **two-file route
change** that:

- starts populating that column on POST,
- splits POST behavior cleanly by `listingMode` so `REPLENISH_EXISTING` never
  mutates an existing lot,
- splits DELETE behavior so removing a replenish item never decrements real
  merchant inventory,
- keeps FIFO recalculation only on paths that actually changed lots.

Once that lands and the SQL invariants confirm no COGS/FIFO damage, the
`/list/[id]` UI work to expose MFN replenish becomes safe to do incrementally.
