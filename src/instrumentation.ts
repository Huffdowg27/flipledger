// Next.js server startup hook (runs once before any requests are handled).
//
// Responsibilities:
//   1. Apply DB table + column migrations via initializeDatabase().
//   2. Start the auto-sync scheduler so syncs run without waiting on the UI to
//      first hit /api/sync/auto. Idempotent — startAutoSync() guards against
//      double-start internally.
//   3. Register SIGTERM/SIGINT handlers that run a WAL checkpoint before the
//      process exits, so PM2 restarts don't risk losing in-flight WAL writes.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { initializeDatabase } = await import('./lib/db');
  initializeDatabase();

  try {
    const { startAutoSync } = await import('./lib/sp-api/auto-sync');
    startAutoSync();
  } catch (err) {
    console.error('[instrumentation] startAutoSync failed:', err);
  }

  registerShutdownHandlers();
}

let shutdownRegistered = false;

function registerShutdownHandlers() {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  const shutdown = (signal: NodeJS.Signals) => {
    try {
      // Lazy-require so module load order can't race with DB init.
      // better-sqlite3 calls are synchronous, so this completes inline before
      // Next.js continues its own shutdown sequence.
      const path = require('path');
      const Database = require('better-sqlite3');
      const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
      const db = new Database(dbPath);
      try {
        db.pragma('journal_mode = WAL');
        db.pragma('wal_checkpoint(TRUNCATE)');
      } finally {
        db.close();
      }
      console.log(`[shutdown] WAL checkpoint complete (${signal})`);
    } catch (err) {
      console.error('[shutdown] WAL checkpoint failed:', err);
    }
    // Do NOT call process.exit here — Next.js installs its own signal
    // handlers and needs to finish its shutdown. Forcing exit can leave
    // HTTP connections half-closed. PM2's kill_timeout (default 1.6s) is
    // the upper bound; the checkpoint above takes <100ms in practice.
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
