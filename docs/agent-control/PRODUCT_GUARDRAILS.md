# FlipLedger Product Guardrails

## North Star

`/mfn/batch` is the operational center for MFN receiving, label printing,
activation preview, and quantity/price push.

`/analyze/merchant-inventory` is visibility/reporting. Do not move the normal
receive -> label -> preview -> push workflow back there.

Every feature should help replace InventoryLab / Prep Ship Hub for the MFN
receive/activate workflow. If it does not help that workflow, do not build it
yet.

## Safety Rules

- Account health comes first.
- Do not add Amazon writes unless the task explicitly asks for them.
- Do not push condition, shipping template, or unsupported attributes.
- `merchant_shipping_group_name` is local-only reference unless a safe
  Amazon-supported method is later verified.
- Do not mutate `inventory_ledger.quantity_remaining` unless explicitly
  requested and reviewed.
- Do not change accounting, P&L, COGS, FIFO, FBA shipments, labels route,
  orders, financial events, or schema unless explicitly requested.
- Prefer small safe commits with build and HTTP verification.

## Required Verification For /mfn/batch Work

- `npm run build`
- `/mfn/batch` returns 200
- `/analyze/merchant-inventory` returns 200
- If activation behavior changes, smoke test activation preview/push shape.
- Show diff and a pre-commit report before committing.

## Current MFN Rules

- `/mfn/batch` may create local lots for Amazon listings that have no local lot.
- Save/create with quantity received implies local inspection for the normal
  workflow.
- Stale local Amazon status is a warning, not a hard activation blocker, when
  a merchant listing row exists.
- Shipping template stays local-only.
- SP-API activation push updates quantity and price only.
- Accepted activation push mirrors local merchant listing status/qty/price.
