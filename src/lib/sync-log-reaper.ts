import type Database from 'better-sqlite3';

const INTERRUPTION_MESSAGE = 'Interrupted by process restart before completion';

/**
 * A startup cannot inherit live work from the previous Node process. Convert
 * abandoned `running` rows into explicit failures so operations never mistake
 * them for in-flight jobs.
 */
export function failInterruptedSyncLogs(
  db: Database.Database,
  completedAt: string = new Date().toISOString(),
): number {
  return db.prepare(`
    UPDATE sync_log
    SET
      status = 'failed',
      completed_at = ?,
      error = CASE
        WHEN error IS NULL OR error = '' THEN ?
        ELSE error || '; ' || ?
      END
    WHERE status = 'running'
  `).run(completedAt, INTERRUPTION_MESSAGE, INTERRUPTION_MESSAGE).changes;
}
