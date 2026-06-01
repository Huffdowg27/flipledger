# Review Checklist

Use this when reviewing Claude's work.

## Before Commit

- `git status --short`
- `git diff --stat`
- `git diff` or focused file diff
- Confirm changed files match the task scope
- Confirm no unrelated rewrites/refactors

## Verification

- `npm run build`
- `/mfn/batch` returns 200
- `/analyze/merchant-inventory` returns 200
- Any task-specific smoke tests from `NEXT_CLAUDE_TASK.md`

## Guardrail Scan

Confirm the diff does not touch restricted areas unless explicitly requested:

- Accounting / P&L / COGS / FIFO
- Orders / financial events
- FBA shipments
- Labels route internals
- Activation routes / SP-API write payloads
- Schema
- `inventory_ledger.quantity_remaining`

## Approval Language

If clean:

```text
Approved to commit.
```

If not clean:

```text
Do not commit yet. Fix the following:
```
