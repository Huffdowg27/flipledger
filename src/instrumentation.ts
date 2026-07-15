// Next.js server startup hook (runs once before any requests are handled).
//
// Responsibilities:
//   1. Apply DB table + column migrations via initializeDatabase().
//   2. Optionally start the auto-sync scheduler for development. Production
//      assigns scheduler ownership to the separate `flipledger-sync` process.
//   3. Register SIGTERM/SIGINT handlers that run a WAL checkpoint before the
//      process exits, so PM2 restarts don't risk losing in-flight WAL writes.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { initializeWebServer } = await import('./lib/server-lifecycle');
  await initializeWebServer();
}
