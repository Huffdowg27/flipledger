import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openFlipLedgerDb } from '../src/lib/sqlite';

test('openFlipLedgerDb sets a 15 second busy timeout before callers run schema work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-timeout-'));
  try {
    const dbPath = path.join(dir, 'flipledger.db');
    const db = openFlipLedgerDb({ dbPath });
    try {
      const rows = db.pragma('busy_timeout') as Array<{ timeout: number }>;
      assert.equal(rows[0]?.timeout, 15000);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
