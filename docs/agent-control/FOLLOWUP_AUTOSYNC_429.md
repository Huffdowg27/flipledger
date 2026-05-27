# Follow-up: auto-sync re-entry + SP-API 429 retry wedge

Filed: 2026-05-17, after commit `d447fcf` (merchant listings freshness fix).
Not to be mixed with the merchant listings work.

## Symptom

PM2 `flipledger` became unresponsive during routine operation. Root URL `/`
and all routes timed out (90s+). `pm2 stop` → `pm2 start` recovered cleanly
(no rebuild needed — already-built `.next` artifacts were intact).

## Evidence from logs (pre-restart)

`/Users/jamiehuff/.pm2/logs/flipledger-out.log`:

```
[AutoSync] Starting reimbursements report sync (18-month window)
[AutoSync] Starting reimbursements report sync (18-month window)
[AutoSync] Starting reimbursements report sync (18-month window)
[AutoSync] Starting reimbursements report sync (18-month window)
```

`/Users/jamiehuff/.pm2/logs/flipledger-error.log`:

```
SP-API 429 on /fba/inventory/v1/summaries, retrying in 3s (attempt 1/3)
SP-API 429 on /fba/inventory/v1/summaries, retrying in 3s (attempt 1/3)
SP-API 429 on /fba/inventory/v1/summaries, retrying in 3s (attempt 1/3)
```

Two distinct concerns:

1. **Re-entry:** The reimbursements report sync log line repeats far more
   often than the weekly cadence `REIMBURSEMENT_CANDIDATES_INTERVAL_HOURS =
   24 * 7` in `src/lib/sp-api/auto-sync.ts` should permit. Suspect the
   `setLastSyncTime('reimbursements_report_last_sync', …)` write isn't
   reached on error paths, so the "should I run?" gate re-fires on every
   15-min tick.

2. **Retry loop:** SP-API 429 retries always log `attempt 1/3` and never
   escalate to `2/3` or `3/3`. Either the counter is never incremented or a
   new request is being issued each time without using the retry state from
   the prior failure. Investigate the wrapper that prints
   `SP-API 429 on … retrying in Xs`.

## Likely interaction

Long-running async reports + non-advancing retry counter + repeated re-entry
= Node event loop saturated with SP-API tasks, Next.js request handlers
queued behind them, app appears wedged.

## Out of scope for this follow-up

- Do not change the merchant listings sync path (`commit d447fcf`).
- Do not change FBA Sales, dashboard, COGS, FIFO, P&L, schema, or anything
  in `PRODUCT_GUARDRAILS.md`'s safety list.

## Investigation steps

1. Add timestamps to the "Starting reimbursements report sync" log line, run
   for ~30 min, confirm whether it really is re-entering or whether it's
   just a single attempt that's spamming the log.
2. Inspect `src/lib/sp-api/reimbursementsReport.ts` + the timestamp-setting
   code in `auto-sync.ts` — is `setLastSyncTime` called only on success?
   It should be called even on failure (with a "tried at" key) to throttle
   retries.
3. Inspect the SP-API client (`src/lib/sp-api/auth.ts` or wherever the 429
   retry wrapper lives) — confirm `attempt` is a real loop counter, not
   hard-coded to 1.
4. Consider a global `Promise.race(longRunningReport, timeout)` so an
   async report can't permanently occupy a worker.

## Acceptance

- Reimbursements report sync runs at most once per `REIMBURSEMENT_
  CANDIDATES_INTERVAL_HOURS` (168h), succeed or fail.
- SP-API 429 retries log `attempt 1/3 → 2/3 → 3/3` and then surface a real
  error or escalate.
- After 24h of uptime, `curl -m 5 http://localhost:3002/` returns 200.
