import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';

import { failInterruptedSyncLogs } from '../src/lib/sync-log-reaper';

test('startup reaper fails only sync rows abandoned in running state', () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE sync_log (
      id INTEGER PRIMARY KEY,
      sync_type TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      status TEXT NOT NULL,
      error TEXT
    );
    INSERT INTO sync_log VALUES
      (1, 'full', '2026-06-01T00:00:00Z', NULL, 'running', NULL),
      (2, 'full', '2026-06-01T01:00:00Z', '2026-06-01T01:05:00Z', 'done', NULL),
      (3, 'returns', '2026-06-01T02:00:00Z', NULL, 'running', 'partial detail');
  `);

  assert.equal(failInterruptedSyncLogs(db, '2026-06-02T00:00:00Z'), 2);
  assert.equal(failInterruptedSyncLogs(db, '2026-06-03T00:00:00Z'), 0);
  const rows = db.prepare(`
    SELECT id, completed_at completedAt, status, error FROM sync_log ORDER BY id
  `).all();
  db.close();

  assert.deepEqual(rows, [
    {
      id: 1,
      completedAt: '2026-06-02T00:00:00Z',
      status: 'failed',
      error: 'Interrupted by process restart before completion',
    },
    {
      id: 2,
      completedAt: '2026-06-01T01:05:00Z',
      status: 'done',
      error: null,
    },
    {
      id: 3,
      completedAt: '2026-06-02T00:00:00Z',
      status: 'failed',
      error: 'partial detail; Interrupted by process restart before completion',
    },
  ]);
});
