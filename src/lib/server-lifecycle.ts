import { initializeDatabase } from './db';
import { openFlipLedgerDb } from './sqlite';

export async function initializeWebServer(): Promise<void> {
  initializeDatabase();

  // Development-only fallback. Production uses the dedicated PM2 worker.
  if (process.env.FLIPLEDGER_START_AUTOSYNC_ON_BOOT === 'true') {
    try {
      const { startAutoSync } = await import('./sp-api/auto-sync');
      startAutoSync({ runInitialTick: false });
    } catch (error) {
      console.error('[lifecycle] startAutoSync failed:', error);
    }
  }

  registerWebShutdownHandlers();
}

export function checkpointFlipLedgerDb(): void {
  const db = openFlipLedgerDb();
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function registerWebShutdownHandlers(): void {
  const globalState = globalThis as typeof globalThis & {
    __flipledgerShutdownRegistered?: boolean;
  };
  if (globalState.__flipledgerShutdownRegistered) return;
  globalState.__flipledgerShutdownRegistered = true;

  const shutdown = (signal: NodeJS.Signals) => {
    try {
      checkpointFlipLedgerDb();
      console.log(`[shutdown] WAL checkpoint complete (${signal})`);
    } catch (error) {
      console.error('[shutdown] WAL checkpoint failed:', error);
    }
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
