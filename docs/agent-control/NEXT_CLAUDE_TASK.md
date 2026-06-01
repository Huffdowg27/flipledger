# Next Claude Task

Task: MFN Receive / Batches merge — safe route-bridge plan first

Context:
FlipLedger currently has two overlapping workflows:

1. `/mfn/batch`
   - Best current MFN receive workflow.
   - Handles existing Seller Central MFN listings.
   - Has trusted MFN search, photos, stale sync display, receive/inspect state, label print, activation preview, and qty/price push.

2. `/list/[id]`
   - Better long-term Prep Ship Hub-style batch shell.
   - Has durable batches, KPI strip, scan/search product section, batch items table, FBA send/boxing flow.
   - But MFN replenish behavior is not safe yet.

Goal:
Figure out the safest way to merge MFN Receive into `/list/[id]` so MFN receiving happens inside Batches long-term.

Do NOT jump into visual polish first.

Critical risk:
`POST /api/list/batches/[id]/items` currently writes/updates `inventory_ledger` directly and can mutate `quantity_remaining`.
That is unsafe for MFN replenish unless guarded carefully.

Read first:
- `src/app/mfn/batch/page.tsx`
- `src/app/api/data/mfn-search/route.ts`
- `src/app/api/data/inventory-lots/create-mfn-local-lot/route.ts`
- `src/app/api/data/inventory-lots/route.ts`
- `src/app/list/[id]/page.tsx`
- `src/app/api/list/batches/[id]/items/route.ts`
- `src/lib/db.ts`
- `docs/agent-control/PRODUCT_GUARDRAILS.md`
- `docs/design-reference/prep-ship-hub/PSH_VISUAL_BRIEF.md`

Deliverable:
Produce a detailed implementation plan for the first safe bridge commit.

The plan should answer:
1. How should MFN `REPLENISH_EXISTING` batch items link to `inventory_ledger_id`?
2. When should the route reuse an existing lot vs create a guarded new one?
3. How do we avoid double-creating inventory?
4. How do we prevent delete/cascade from decrementing real MFN inventory incorrectly?
5. Which fields stay on `inventory_ledger` vs `listing_batch_items`?
6. What exact tests/SQL verification prove no COGS/FIFO damage?
7. What should be implemented first, and what should explicitly wait?

Hard guardrails:
- Do not touch COGS/P&L/FIFO math.
- Do not mutate `quantity_remaining` except through already-reviewed FIFO/lot semantics.
- Do not change SP-API push payloads.
- Do not change activation-preview/push behavior yet.
- Do not change FBA batch behavior.
- Do not do broad UI polish in this task.
- Do not stage or commit unrelated files.

Preferred first implementation target after planning:
A small route-only bridge commit that makes `/api/list/batches/[id]/items` safe for MFN `REPLENISH_EXISTING`, using `inventory_ledger_id`, without changing UI yet.
