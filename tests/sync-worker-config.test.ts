import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';

test('PM2 assigns auto-sync ownership only to the dedicated worker', () => {
  const require = createRequire(import.meta.url);
  const config = require(path.join(process.cwd(), 'ecosystem.config.js')) as {
    apps: Array<{
      name: string;
      script: string;
      args?: string;
      interpreter?: string;
      node_args?: string;
      kill_timeout?: number;
      env?: Record<string, string>;
    }>;
  };

  const web = config.apps.find((app) => app.name === 'flipledger');
  const worker = config.apps.find((app) => app.name === 'flipledger-sync');

  assert.ok(web);
  assert.equal(web.env?.FLIPLEDGER_START_AUTOSYNC_ON_BOOT, 'false');
  assert.equal(web.env?.FLIPLEDGER_AUTOSYNC_CONTROL, 'external');
  assert.equal(web.env?.TZ, 'America/Los_Angeles');

  assert.ok(worker);
  assert.equal(worker.script, 'src/sync-worker.ts');
  assert.equal(worker.interpreter, 'node');
  assert.equal(worker.node_args, '--import tsx');
  assert.ok((worker.kill_timeout || 0) >= 8 * 60 * 1000);
  assert.equal(worker.env?.TZ, 'America/Los_Angeles');
});
