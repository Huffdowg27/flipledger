import { NextRequest, NextResponse } from 'next/server';
import Database from 'better-sqlite3';
import path from 'path';

const EBAY_RUNAME = 'Parker_Morgan-ParkerMo-CardGr-amogmj';

/**
 * GET /api/ebay-auth — Step 1: Redirects to eBay OAuth consent page
 * GET /api/ebay-auth?code=xxx — Step 2: Handles callback, exchanges code for refresh token
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');

  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  const clientId = (db.prepare("SELECT value FROM settings WHERE key = 'ebay_client_id'").get() as any)?.value;
  const clientSecret = (db.prepare("SELECT value FROM settings WHERE key = 'ebay_client_secret'").get() as any)?.value;

  if (!clientId || !clientSecret) {
    db.close();
    return NextResponse.json({ error: 'Save your eBay Client ID and Client Secret in Settings first.' }, { status: 400 });
  }

  // Step 2: Exchange authorization code for tokens
  if (code) {
    const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

    const response = await fetch('https://api.ebay.com/identity/v1/oauth2/token', {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `grant_type=authorization_code&code=${encodeURIComponent(code)}&redirect_uri=${encodeURIComponent(EBAY_RUNAME)}`,
    });

    const data = await response.json();

    if (data.refresh_token) {
      db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ebay_refresh_token', ?)").run(data.refresh_token);
      db.close();

      return new NextResponse(`
        <html><body style="font-family:system-ui;background:#1a1a2e;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
          <div style="text-align:center">
            <h1 style="color:#4ade80">✓ eBay Connected!</h1>
            <p>Refresh token saved. You can close this tab and go back to FlipLedger Settings to sync.</p>
          </div>
        </body></html>
      `, { headers: { 'Content-Type': 'text/html' } });
    }

    db.close();
    return NextResponse.json({
      error: 'Failed to get refresh token from eBay',
      ebay_response: data,
    }, { status: 400 });
  }

  db.close();

  // Step 1: Redirect to eBay consent page
  const scopes = encodeURIComponent([
    'https://api.ebay.com/oauth/api_scope',
    'https://api.ebay.com/oauth/api_scope/sell.fulfillment',
    'https://api.ebay.com/oauth/api_scope/sell.finances',
    'https://api.ebay.com/oauth/api_scope/sell.account',
  ].join(' '));

  const ebayAuthUrl = `https://auth.ebay.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(EBAY_RUNAME)}&response_type=code&scope=${scopes}`;

  return NextResponse.redirect(ebayAuthUrl);
}
