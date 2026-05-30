// Next.js server startup hook (runs once before any requests are handled).
//
// Responsibilities:
//   1. Apply DB table + column migrations via initializeDatabase().
//   2. Optionally start the auto-sync scheduler. Keep this opt-in until the
//      web/sync PM2 split lands; starting a long sync inside the web process
//      during boot can make the app unavailable right after deploy.
//   3. Register SIGTERM/SIGINT handlers that run a WAL checkpoint before the
//      process exits, so PM2 restarts don't risk losing in-flight WAL writes.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { initializeDatabase } = await import('./lib/db');
  initializeDatabase();

  if (process.env.FLIPLEDGER_START_AUTOSYNC_ON_BOOT === 'true') {
    try {
      const globalState = globalThis as typeof globalThis & {
        __flipledgerAutoSyncStarted?: boolean;
      };

      if (!globalState.__flipledgerAutoSyncStarted) {
        globalState.__flipledgerAutoSyncStarted = true;
        const { startAutoSync } = await import('./lib/sp-api/auto-sync');
        startAutoSync();
      }
    } catch (err) {
      console.error('[instrumentation] startAutoSync failed:', err);
    }
  }

  registerShutdownHandlers();
}

function registerShutdownHandlers() {
  const globalState = globalThis as typeof globalThis & {
    __flipledgerShutdownRegistered?: boolean;
  };

  if (globalState.__flipledgerShutdownRegistered) return;
  globalState.__flipledgerShutdownRegistered = true;

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
