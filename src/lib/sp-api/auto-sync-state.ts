import { getSetting, upsertSettings } from '../settings';
import { openFlipLedgerDb } from '../sqlite';

const AUTO_SYNC_PID_KEY = 'auto_sync_process_pid';
const AUTO_SYNC_STARTED_AT_KEY = 'auto_sync_started_at';
const AUTO_SYNC_STOPPED_AT_KEY = 'auto_sync_stopped_at';

export function isRecordedAutoSyncProcessAlive(
  recordedPid: string | null,
  probe: (pid: number) => boolean = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
  },
): boolean {
  if (!recordedPid || !/^\d+$/.test(recordedPid)) return false;
  const pid = Number(recordedPid);
  return Number.isSafeInteger(pid) && pid > 0 && probe(pid);
}

export function shouldStartAutoSync(
  localIntervalRunning: boolean,
  persistedProcessRunning: boolean,
): boolean {
  return !localIntervalRunning && !persistedProcessRunning;
}

export function markAutoSyncRunning(now: Date = new Date()): void {
  const db = openFlipLedgerDb();
  try {
    upsertSettings(db, [
      [AUTO_SYNC_PID_KEY, String(process.pid)],
      [AUTO_SYNC_STARTED_AT_KEY, now.toISOString()],
    ]);
  } finally {
    db.close();
  }
}

export function markAutoSyncStopped(now: Date = new Date()): void {
  const db = openFlipLedgerDb();
  try {
    upsertSettings(db, [
      [AUTO_SYNC_PID_KEY, ''],
      [AUTO_SYNC_STOPPED_AT_KEY, now.toISOString()],
    ]);
  } finally {
    db.close();
  }
}

export function isPersistedAutoSyncRunning(): boolean {
  let db: ReturnType<typeof openFlipLedgerDb> | null = null;
  try {
    db = openFlipLedgerDb({ readonly: true, fileMustExist: true });
    return isRecordedAutoSyncProcessAlive(getSetting(db, AUTO_SYNC_PID_KEY));
  } catch {
    return false;
  } finally {
    db?.close();
  }
}
