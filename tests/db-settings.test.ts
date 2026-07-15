import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getAmazonCredentials,
  getSetting,
  readSettings,
  upsertSetting,
  upsertSettings,
} from '../src/lib/settings';
import { isRecordedAutoSyncProcessAlive, shouldStartAutoSync } from '../src/lib/sp-api/auto-sync-state';
import { openFlipLedgerDb } from '../src/lib/sqlite';

function makeDb() {
  const db = openFlipLedgerDb({ dbPath: ':memory:' });
  db.exec(`
    CREATE TABLE settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

test('openFlipLedgerDb creates parent directories and enables foreign keys for writes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flipledger-db-'));
  const dbPath = path.join(dir, 'nested', 'flipledger.db');
  const db = openFlipLedgerDb({ dbPath });
  try {
    assert.equal(fs.existsSync(path.dirname(dbPath)), true);
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings helpers read all settings or an explicit key subset', () => {
  const db = makeDb();
  try {
    upsertSettings(db, [
      ['clientId', 'client'],
      ['clientSecret', 'secret'],
      ['dashboard_layout', '{"order":[]}'],
    ]);

    assert.deepEqual(readSettings(db, ['clientId', 'dashboard_layout']), {
      clientId: 'client',
      dashboard_layout: '{"order":[]}',
    });
    assert.equal(readSettings(db).clientSecret, 'secret');
    assert.equal(getSetting(db, 'missing'), null);
  } finally {
    db.close();
  }
});

test('settings helpers upsert single values and batches', () => {
  const db = makeDb();
  try {
    upsertSetting(db, 'marketplaceId', 'ATVPDKIKX0DER');
    upsertSettings(db, [
      ['marketplaceId', 'A2EUQ1WTGCTBG2'],
      ['profit_target_monthly', '5000'],
    ]);

    assert.equal(getSetting(db, 'marketplaceId'), 'A2EUQ1WTGCTBG2');
    assert.equal(getSetting(db, 'profit_target_monthly'), '5000');
  } finally {
    db.close();
  }
});

test('getAmazonCredentials requires core secrets and defaults marketplace', () => {
  const db = makeDb();
  try {
    assert.equal(getAmazonCredentials(db), null);

    upsertSettings(db, [
      ['clientId', 'client'],
      ['clientSecret', 'secret'],
      ['refreshToken', 'refresh'],
    ]);

    assert.deepEqual(getAmazonCredentials(db), {
      clientId: 'client',
      clientSecret: 'secret',
      refreshToken: 'refresh',
      marketplaceId: 'ATVPDKIKX0DER',
    });
  } finally {
    db.close();
  }
});

test('auto-sync status trusts only a live numeric process id', () => {
  const probes: number[] = [];
  const probe = (pid: number) => {
    probes.push(pid);
    return pid === 4242;
  };

  assert.equal(isRecordedAutoSyncProcessAlive('4242', probe), true);
  assert.equal(isRecordedAutoSyncProcessAlive('4243', probe), false);
  assert.equal(isRecordedAutoSyncProcessAlive('', probe), false);
  assert.equal(isRecordedAutoSyncProcessAlive('not-a-pid', probe), false);
  assert.equal(isRecordedAutoSyncProcessAlive(null, probe), false);
  assert.deepEqual(probes, [4242, 4243]);
});

test('auto-sync start guard blocks duplicate schedulers across module contexts', () => {
  assert.equal(shouldStartAutoSync(false, false), true);
  assert.equal(shouldStartAutoSync(true, false), false);
  assert.equal(shouldStartAutoSync(false, true), false);
  assert.equal(shouldStartAutoSync(true, true), false);
});
