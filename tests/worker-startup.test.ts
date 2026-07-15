import test from 'node:test';
import assert from 'node:assert/strict';

import { initializeDatabaseWithRetry } from '../src/lib/worker-startup';

test('sync worker retries SQLite startup contention and then succeeds', async () => {
  let calls = 0;
  const sleeps: number[] = [];

  await initializeDatabaseWithRetry(() => {
    calls++;
    if (calls < 3) {
      const error = new Error('database is locked') as NodeJS.ErrnoException;
      error.code = 'SQLITE_BUSY';
      throw error;
    }
  }, {
    attempts: 4,
    delayMs: 25,
    sleep: async (ms) => { sleeps.push(ms); },
  });

  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [25, 25]);
});

test('sync worker does not retry non-contention startup errors', async () => {
  let calls = 0;
  await assert.rejects(
    initializeDatabaseWithRetry(() => {
      calls++;
      throw new Error('migration is invalid');
    }, {
      attempts: 4,
      sleep: async () => undefined,
    }),
    /migration is invalid/,
  );
  assert.equal(calls, 1);
});
