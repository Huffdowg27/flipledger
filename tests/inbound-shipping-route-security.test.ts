import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';

test('inbound shipping rejects unsafe marketplace before database queries', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-shipping-'));
  fs.mkdirSync(path.join(dir, 'data'));
  const db = new Database(path.join(dir, 'data', 'flipledger.db'));
  db.pragma('journal_mode = WAL');
  db.close();
  const previous = process.cwd();
  try {
    process.chdir(dir);
    const { GET } = await import('../src/app/api/data/inbound-shipping/route');
    const marketplace = encodeURIComponent(`amazon' OR 1=1 --`);
    const response = await GET(new NextRequest(`http://localhost/api/data/inbound-shipping?marketplace=${marketplace}`));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid marketplace' });
  } finally {
    process.chdir(previous);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
