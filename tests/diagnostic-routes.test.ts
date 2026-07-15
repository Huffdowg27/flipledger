import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areDiagnosticRoutesEnabled,
  areSpApiDiagnosticsEnabled,
} from '../src/lib/diagnostic-routes';

test('diagnostic routes are disabled unless explicitly enabled', () => {
  assert.equal(areDiagnosticRoutesEnabled({}), false);
  assert.equal(areDiagnosticRoutesEnabled({ FLIPLEDGER_ENABLE_DIAGNOSTIC_ROUTES: 'false' }), false);
  assert.equal(areDiagnosticRoutesEnabled({ FLIPLEDGER_ENABLE_DIAGNOSTIC_ROUTES: '1' }), false);
  assert.equal(areDiagnosticRoutesEnabled({ FLIPLEDGER_ENABLE_DIAGNOSTIC_ROUTES: 'true' }), true);
});

test('SP-API diagnostics use the narrower live-write flag', () => {
  assert.equal(areSpApiDiagnosticsEnabled({}), false);
  assert.equal(areSpApiDiagnosticsEnabled({ FLIPLEDGER_ENABLE_DIAGNOSTIC_ROUTES: 'true' }), false);
  assert.equal(areSpApiDiagnosticsEnabled({ FLIPLEDGER_ENABLE_SPAPI_DIAGNOSTICS: 'true' }), true);
});
