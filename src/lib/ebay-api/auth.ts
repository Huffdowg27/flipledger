/**
 * eBay Marketplace API authentication.
 * Uses OAuth 2.0 refresh_token grant → access token (2 hour expiry).
 */

import type { EbayCredentials, EbayTokenResponse } from './types';
import Database from 'better-sqlite3';
import path from 'path';

const EBAY_TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_API_SCOPES = 'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.fulfillment https://api.ebay.com/oauth/api_scope/sell.finances';

// In-memory token cache
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Get eBay credentials from settings table.
 */
export function getEbayCredentials(): EbayCredentials | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');

  try {
    const clientId = (db.prepare("SELECT value FROM settings WHERE key = 'ebay_client_id'").get() as any)?.value;
    const clientSecret = (db.prepare("SELECT value FROM settings WHERE key = 'ebay_client_secret'").get() as any)?.value;
    const refreshToken = (db.prepare("SELECT value FROM settings WHERE key = 'ebay_refresh_token'").get() as any)?.value;

    if (!clientId || !clientSecret || !refreshToken) return null;
    return { clientId, clientSecret, refreshToken };
  } finally {
    db.close();
  }
}

/**
 * Get a valid access token, refreshing if expired.
 */
export async function getAccessToken(credentials: EbayCredentials): Promise<string> {
  // Return cached token if still valid (with 120s buffer)
  if (cachedToken && Date.now() < tokenExpiry - 120000) {
    return cachedToken;
  }

  const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

  const response = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(credentials.refreshToken)}&scope=${encodeURIComponent(EBAY_API_SCOPES)}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`eBay auth failed (${response.status}): ${text}`);
  }

  const data: EbayTokenResponse = await response.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in * 1000);

  return cachedToken;
}

/**
 * Clear cached token (call when credentials change).
 */
export function clearTokenCache() {
  cachedToken = null;
  tokenExpiry = 0;
}

/**
 * Make an authenticated request to the eBay API.
 * Handles retries for 429 (rate limit) and 5xx errors.
 */
export async function ebayApiRequest(
  credentials: EbayCredentials,
  url: string,
  params?: Record<string, string>,
  method: 'GET' | 'POST' = 'GET',
  body?: any,
  maxRetries: number = 3,
): Promise<any> {
  let token = await getAccessToken(credentials);

  let fullUrl = url;
  if (params) {
    const searchParams = new URLSearchParams(params);
    fullUrl += `?${searchParams.toString()}`;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method, headers };
    if (body && method === 'POST') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(fullUrl, fetchOptions);

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    }

    // Rate limited — wait and retry
    if (response.status === 429) {
      const retryAfter = response.headers.get('Retry-After');
      const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : (attempt + 1) * 5000;
      console.warn(`[eBay] Rate limited. Waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Server error — retry with backoff
    if (response.status >= 500 && attempt < maxRetries) {
      const waitMs = (attempt + 1) * 3000;
      console.warn(`[eBay] Server error ${response.status}. Waiting ${waitMs}ms before retry`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Token expired — refresh and retry once
    if (response.status === 401 && attempt === 0) {
      clearTokenCache();
      token = await getAccessToken(credentials);
      continue;
    }

    const text = await response.text();
    throw new Error(`eBay API error ${response.status} on ${url}: ${text.substring(0, 500)}`);
  }

  throw new Error(`eBay API request failed after ${maxRetries} retries: ${url}`);
}
