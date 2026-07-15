import { NextResponse } from 'next/server';

type Env = Record<string, string | undefined>;

const ENABLE_DIAGNOSTIC_ROUTES = 'FLIPLEDGER_ENABLE_DIAGNOSTIC_ROUTES';
const ENABLE_SPAPI_DIAGNOSTICS = 'FLIPLEDGER_ENABLE_SPAPI_DIAGNOSTICS';

export function areDiagnosticRoutesEnabled(env: Env = process.env): boolean {
  return env[ENABLE_DIAGNOSTIC_ROUTES] === 'true';
}

export function areSpApiDiagnosticsEnabled(env: Env = process.env): boolean {
  return env[ENABLE_SPAPI_DIAGNOSTICS] === 'true';
}

function notFoundResponse() {
  return NextResponse.json({ error: 'Not found' }, { status: 404 });
}

export function requireDiagnosticRoute(env: Env = process.env) {
  return areDiagnosticRoutesEnabled(env) ? null : notFoundResponse();
}

export function requireSpApiDiagnosticRoute(env: Env = process.env) {
  return areSpApiDiagnosticsEnabled(env) ? null : notFoundResponse();
}
