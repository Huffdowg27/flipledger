// Next.js server startup hook (runs once before any requests are handled).
// Ensures all DB tables and column migrations in initializeDatabase() are
// applied on every boot — no manual sqlite3 ALTERs needed on fresh installs.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initializeDatabase } = await import('./lib/db');
    initializeDatabase();
  }
}
