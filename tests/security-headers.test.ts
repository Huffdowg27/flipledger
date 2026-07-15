import test from 'node:test';
import assert from 'node:assert/strict';

import nextConfig from '../next.config';

test('all routes receive the production security-header baseline', async () => {
  assert.equal(nextConfig.poweredByHeader, false);
  assert.equal(typeof nextConfig.headers, 'function');
  const rules = await nextConfig.headers!();
  const catchAll = rules.find((rule) => rule.source === '/(.*)');
  assert.ok(catchAll);

  const headers = Object.fromEntries(
    catchAll.headers.map(({ key, value }) => [key.toLowerCase(), value]),
  );
  assert.equal(headers['x-content-type-options'], 'nosniff');
  assert.equal(headers['x-frame-options'], 'DENY');
  assert.equal(headers['referrer-policy'], 'same-origin');
  assert.match(headers['permissions-policy'], /camera=\(\)/);
  assert.match(headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(headers['content-security-policy'], /object-src 'none'/);
});
