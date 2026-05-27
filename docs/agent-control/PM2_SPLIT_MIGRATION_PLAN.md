# PM2 web/sync split — migration plan

Status: NOT IMPLEMENTED. Plan only. Do not start without explicit go-ahead.

Filed: 2026-05-26.

## Goal

Today FlipLedger is one PM2 process running `next start` on port 3002. The
hourly auto-sync (orders, finances, inventory, catalog, settlement, merchant
listings, fees) runs inside that same Node event loop. When a sync stage
backs off on 429s or a long async report takes minutes, HTTP request handlers
queue behind it and the UI feels frozen.

Codex's recent endpoint-family rate limiter and catalog cooldown removed most
of the 429 storm. The next durable improvement is a second PM2 process that
owns sync, leaving the web process free to serve requests.

## Target topology

```
┌──────────────────┐        ┌──────────────────┐
│ flipledger-web   │        │ flipledger-sync  │
│ next start :3002 │        │ node sync-worker │
│  - serves UI     │        │  - hourly tick   │
│  - read APIs     │        │  - long reports  │
│  - manual sync   │        │  - FIFO recalc   │
│    triggers      │        │                  │
└────────┬─────────┘        └────────┬─────────┘
         │                           │
         └────────── SQLite ─────────┘
              data/flipledger.db
                  (WAL mode)
```

Both processes share the same SQLite DB via WAL journaling. SQLite WAL handles
multi-process read concurrency fine and serializes writes via filesystem locks.
No new IPC or message bus required.

## What moves to the sync process

From `src/lib/sp-api/auto-sync.ts` and friends:

- `startAutoSync()` — 15-minute tick loop
- `runFullSync()` — orders, finances, inventory, catalog, settlement, merchant
  listings, fees
- All `runGatedSync`-wrapped jobs — customer returns, sales rank,
  reimbursements report, reimbursement candidates
- Walmart `runWalmartSync()` and dispute candidates
- eBay `runEbaySync()`
- Recurring expense generation, FIFO recalc

What stays on the web process:

- Everything in `src/app/**` (API routes + pages)
- `/api/sync/auto` — repurposed as a "tell the worker to start" trigger
  (or removed once instrumentation handles boot startup)
- `/api/sync` — manual sync trigger. Still needs to exist for users; can
  either POST a flag the worker polls for, or proxy to the worker over a
  loopback HTTP port.
- `/api/data/*` — read APIs

## Migration steps

### 1. Extract the sync worker entrypoint (no behavior change)
- New file `src/sync-worker.ts` that calls `initializeDatabase()` then
  `startAutoSync()` and stays alive.
- Already-existing modules (`auto-sync.ts`, `sync.ts`, etc.) are imported
  unchanged.
- Verify it runs standalone with `npx tsx src/sync-worker.ts`.

### 2. Add a build step for the worker
- Either ship as TypeScript via `tsx` (simplest, adds tsx dependency), or
  compile via `esbuild` to `dist/sync-worker.js` and run with `node`.
- `tsx` is cleaner for a single-machine deploy; pin a version.

### 3. Stop the web process from starting auto-sync
- Remove or short-circuit the `startAutoSync()` call in
  `src/instrumentation.ts` when `process.env.FLIPLEDGER_ROLE === 'web'`.
- `src/sync-worker.ts` sets/reads `FLIPLEDGER_ROLE === 'sync'`.
- `/api/sync/auto` becomes a no-op when role=web (keeps the UI from
  starting a sync loop in-process).

### 4. Add the second PM2 process
Create `ecosystem.config.js` entries for both:
```js
module.exports = {
  apps: [
    {
      name: 'flipledger-web',
      cwd: '/Users/jamiehuff/flipledger',
      script: 'npm',
      args: 'start',
      env: { FLIPLEDGER_ROLE: 'web' },
    },
    {
      name: 'flipledger-sync',
      cwd: '/Users/jamiehuff/flipledger',
      script: 'npx',
      args: 'tsx src/sync-worker.ts',
      env: { FLIPLEDGER_ROLE: 'sync' },
    },
  ],
};
```

### 5. Manual sync triggers
- Web `/api/sync` needs to reach the worker. Options:
  - **Loopback HTTP** (simplest): worker exposes a tiny HTTP server on
    127.0.0.1:3003 with a single POST /trigger endpoint. Web POSTs to it.
  - **DB flag** (no second port): web inserts a row in a `sync_trigger`
    table; worker polls every 5s. Slower feedback but zero new sockets.
- Recommend loopback HTTP. The worker already needs to be a long-lived
  Node process; adding `http.createServer` is ~30 LOC.

### 6. Verify, then cut over
- Run both processes in parallel for one day with auto-sync DISABLED on the
  web process, ENABLED on the worker. Confirm web stays responsive.
- Then `pm2 delete flipledger` (the old single process).

## Risks

1. **DB lock contention.** SQLite write serialization is filesystem-level. If
   the worker holds a write transaction (e.g., during the inventory upsert
   loop) and the web tries to write a setting at the same time, the web waits.
   Mitigation: keep write transactions short; the existing code already does
   per-row inserts inside loops, which is non-ideal for throughput but fine
   for contention.
2. **Migration order on fresh boot.** Both processes call
   `initializeDatabase()`. With idempotent `CREATE IF NOT EXISTS` + ALTER
   guards, this is safe — but if both race on first boot of a fresh DB, one
   will see "table already exists" errors during ALTER. Already harmless in
   current code (try/catch in colMigrations), but worth confirming.
3. **Lost trigger.** If the worker is down when the web POSTs a manual
   trigger, the trigger is lost. Mitigation: persist trigger as DB row; worker
   replays on next start.
4. **Doubled boot logs.** Both processes log to PM2. Tag log lines with
   `[web]` / `[sync]` prefix or use separate `pm2_log_paths`.
5. **Two `inFlight` Sets / two `currentSync` singletons.** These are module-
   scoped state — after split, the web process can't see the sync process's
   in-flight locks. If web's `/api/sync` triggers a manual sync directly
   instead of routing to the worker, you'd have two parallel `runFullSync`
   calls. The split MUST move all sync execution to the worker; the web
   process's role is to request, not execute.

## What this does NOT solve

- Long async reports (reimbursements, merchant listings) will still take
  minutes — they just won't block the UI now.
- The WAL checkpoint at shutdown is still needed (per
  `instrumentation.ts`).
- COGS audit, MFN batch lifecycle, Labels tab — all unrelated.

## Effort estimate

2–3 days, including the cut-over day where both processes run side by side.
The actual code change is small (~150 new LOC + ecosystem.config.js); most of
the time is validating that nothing in the web process implicitly assumes the
sync singletons exist in-memory.

## Go/no-go criteria

Do this when:
- The rate limiter has been live for a week with zero PM2 restarts attributed
  to wedging.
- OR an actual stall recurs despite the rate limiter (would prove the
  limiter alone isn't enough).

Don't do this now — the rate limiter is fresh, and a week of clean uptime is
the cheaper diagnostic.
