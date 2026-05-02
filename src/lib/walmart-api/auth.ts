/**
 * Walmart Marketplace API authentication.
 * Uses Client ID + Client Secret → access token (15 min expiry).
 */

import { v4 as uuidv4 } from 'uuid';
import type { WalmartCredentials, WalmartTokenResponse } from './types';
import Database from 'better-sqlite3';
import path from 'path';

const WALMART_TOKEN_URL = 'https://marketplace.walmartapis.com/v3/token';
const WALMART_API_BASE = 'https://marketplace.walmartapis.com/v3';

// In-memory token cache
let cachedToken: string | null = null;
let tokenExpiry: number = 0;

/**
 * Get Walmart credentials from settings table.
 */
export function getWalmartCredentials(): WalmartCredentials | null {
  const dbPath = path.join(process.cwd(), 'data', 'flipledger.db');
  const db = new Database(dbPath, { readonly: true });
  db.pragma('journal_mode = WAL');

  try {
    const clientId = (db.prepare("SELECT value FROM settings WHERE key = 'walmart_client_id'").get() as any)?.value;
    const clientSecret = (db.prepare("SELECT value FROM settings WHERE key = 'walmart_client_secret'").get() as any)?.value;

    if (!clientId || !clientSecret) return null;
    return { clientId, clientSecret };
  } finally {
    db.close();
  }
}

/**
 * Get a valid access token, refreshing if expired.
 */
export async function getAccessToken(credentials: WalmartCredentials): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < tokenExpiry - 60000) {
    return cachedToken;
  }

  const basicAuth = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');

  const response = await fetch(WALMART_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basicAuth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': uuidv4(),
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Walmart auth failed (${response.status}): ${text}`);
  }

  const data: WalmartTokenResponse = await response.json();
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
 * Make an authenticated request to the Walmart API.
 * Handles retries for 429 (rate limit) and 5xx errors.
 */
export async function walmartApiRequest(
  credentials: WalmartCredentials,
  endpoint: string,
  params?: Record<string, string>,
  method: 'GET' | 'POST' = 'GET',
  body?: any,
  maxRetries: number = 3,
): Promise<any> {
  const token = await getAccessToken(credentials);

  let url = `${WALMART_API_BASE}${endpoint}`;
  if (params) {
    const searchParams = new URLSearchParams(params);
    url += `?${searchParams.toString()}`;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const headers: Record<string, string> = {
      'WM_SEC.ACCESS_TOKEN': token,
      'WM_SVC.NAME': 'Walmart Marketplace',
      'WM_QOS.CORRELATION_ID': uuidv4(),
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    };

    const fetchOptions: RequestInit = { method, headers };
    if (body && method === 'POST') {
      fetchOptions.body = JSON.stringify(body);
    }

    const response = await fetch(url, fetchOptions);

    if (response.ok) {
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    }

    // Rate limited — wait and retry
    if (response.status === 429) {
      const retryAfter = response.headers.get('X-Next-Replenishment-Time');
      const waitMs = retryAfter ? Math.max(1000, new Date(retryAfter).getTime() - Date.now()) : (attempt + 1) * 5000;
      console.warn(`Walmart API rate limited. Waiting ${waitMs}ms before retry ${attempt + 1}/${maxRetries}`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Server error — retry with backoff
    if (response.status >= 500 && attempt < maxRetries) {
      const waitMs = (attempt + 1) * 3000;
      console.warn(`Walmart API server error ${response.status}. Waiting ${waitMs}ms before retry`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    // Token expired — refresh and retry once
    if (response.status === 401 && attempt === 0) {
      clearTokenCache();
      const newToken = await getAccessToken(credentials);
      headers['WM_SEC.ACCESS_TOKEN'] = newToken;
      continue;
    }

    const text = await response.text();
    throw new Error(`Walmart API error ${response.status} on ${endpoint}: ${text}`);
  }

  throw new Error(`Walmart API request failed after ${maxRetries} retries: ${endpoint}`);
}
