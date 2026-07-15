import { initializeDatabase } from './lib/db';
import { checkpointFlipLedgerDb } from './lib/server-lifecycle';
import { initializeDatabaseWithRetry } from './lib/worker-startup';
import {
  startAutoSync,
  stopAutoSync,
  waitForAutoSyncIdle,
} from './lib/sp-api/auto-sync';

let shuttingDown = false;
const shutdown = async (signal: NodeJS.Signals) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[sync-worker] ${signal} received; draining the active sync tick`);
  stopAutoSync();

  const drained = await waitForAutoSyncIdle(8 * 60 * 1000);
  if (!drained) {
    console.error('[sync-worker] Active sync did not drain within 8 minutes');
    process.exitCode = 1;
    return;
  }

  checkpointFlipLedgerDb();
  console.log('[sync-worker] Clean shutdown complete');
};

function handleSignal(signal: NodeJS.Signals): void {
  void shutdown(signal).then(
    () => process.exit(process.exitCode || 0),
    (error) => {
      console.error('[sync-worker] Shutdown failed:', error);
      process.exit(1);
    },
  );
}

process.once('SIGTERM', () => handleSignal('SIGTERM'));
process.once('SIGINT', () => handleSignal('SIGINT'));

async function main(): Promise<void> {
  await initializeDatabaseWithRetry(initializeDatabase);

  if (!startAutoSync({ runInitialTick: false })) {
    throw new Error(
      'Another live FlipLedger auto-sync scheduler already owns the lease.',
    );
  }

  console.log(`[sync-worker] Scheduler online (pid ${process.pid})`);
}

void main().catch((error) => {
  console.error('[sync-worker] Startup failed:', error);
  process.exit(1);
});
