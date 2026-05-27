/**
 * SP-API LWA (Login With Amazon) authentication.
 * Exchanges refresh token for access token, auto-refreshes on expiry.
 */

const LWA_TOKEN_URL = 'https://api.amazon.com/auth/o2/token';

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
}

interface SPAPICredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  marketplaceId: string;
}

let cachedToken: { accessToken: string; expiresAt: number } | null = null;

type EndpointFamily =
  | 'catalog'
  | 'inventory'
  | 'orders'
  | 'finances'
  | 'reports'
  | 'listings'
  | 'inbound'
  | 'sellers'
  | 'default';

interface EndpointRateLimit {
  ratePerSecond: number;
  burst: number;
}

const ENDPOINT_RATE_LIMITS: Record<EndpointFamily, EndpointRateLimit> = {
  catalog: { ratePerSecond: 1.8, burst: 2 },
  inventory: { ratePerSecond: 1.8, burst: 2 },
  orders: { ratePerSecond: 0.8, burst: 2 },
  finances: { ratePerSecond: 0.5, burst: 1 },
  reports: { ratePerSecond: 0.5, burst: 1 },
  listings: { ratePerSecond: 1.5, burst: 2 },
  inbound: { ratePerSecond: 1.5, burst: 2 },
  sellers: { ratePerSecond: 1, burst: 1 },
  default: { ratePerSecond: 2, burst: 2 },
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

class EndpointRateLimiter {
  private tokens: number;
  private updatedAt = Date.now();
  private queue: Promise<void> = Promise.resolve();
  private cooldownUntil = 0;

  constructor(private readonly limit: EndpointRateLimit) {
    this.tokens = limit.burst;
  }

  async wait() {
    const previous = this.queue.catch(() => undefined);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    this.queue = previous.then(() => gate);

    await previous;
    try {
      await this.takeToken();
    } finally {
      release();
    }
  }

  recordThrottle(waitMs: number) {
    this.tokens = 0;
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + waitMs);
  }

  private refill(now: number) {
    const elapsedSeconds = Math.max(0, (now - this.updatedAt) / 1000);
    this.tokens = Math.min(
      this.limit.burst,
      this.tokens + elapsedSeconds * this.limit.ratePerSecond
    );
    this.updatedAt = now;
  }

  private async takeToken() {
    while (true) {
      const now = Date.now();

      if (this.cooldownUntil > now) {
        await sleep(this.cooldownUntil - now);
        continue;
      }

      this.refill(now);

      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      const waitMs = Math.ceil(((1 - this.tokens) / this.limit.ratePerSecond) * 1000);
      await sleep(Math.max(waitMs, 50));
    }
  }
}

const limiters = new Map<EndpointFamily, EndpointRateLimiter>();

function endpointFamilyForPath(path: string): EndpointFamily {
  if (path.startsWith('/catalog/')) return 'catalog';
  if (path.startsWith('/fba/inventory/')) return 'inventory';
  if (path.startsWith('/orders/')) return 'orders';
  if (path.startsWith('/finances/')) return 'finances';
  if (path.startsWith('/reports/')) return 'reports';
  if (path.startsWith('/listings/')) return 'listings';
  if (path.startsWith('/fba/inbound/') || path.startsWith('/inbound/')) return 'inbound';
  if (path.startsWith('/sellers/')) return 'sellers';
  return 'default';
}

function getEndpointLimiter(path: string) {
  const family = endpointFamilyForPath(path);
  let limiter = limiters.get(family);
  if (!limiter) {
    limiter = new EndpointRateLimiter(ENDPOINT_RATE_LIMITS[family]);
    limiters.set(family, limiter);
  }
  return limiter;
}

function getRetryAfterSeconds(value: string | null, fallbackSeconds: number) {
  if (!value) return fallbackSeconds;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) return seconds;

  const retryDate = Date.parse(value);
  if (Number.isFinite(retryDate)) {
    return Math.max(1, Math.ceil((retryDate - Date.now()) / 1000));
  }

  return fallbackSeconds;
}

/**
 * Get a valid access token, refreshing if needed.
 * Caches the token in memory and refreshes 60s before expiry.
 */
export async function getAccessToken(credentials: SPAPICredentials): Promise<string> {
  const now = Date.now();

  if (cachedToken && cachedToken.expiresAt > now + 60000) {
    return cachedToken.accessToken;
  }

  const response = await fetch(LWA_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: credentials.refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`LWA token exchange failed (${response.status}): ${error}`);
  }

  const data: TokenResponse = await response.json();

  cachedToken = {
    accessToken: data.access_token,
    expiresAt: now + data.expires_in * 1000,
  };

  return cachedToken.accessToken;
}

/** Clear cached token (for testing or credential changes) */
export function clearTokenCache() {
  cachedToken = null;
}

/** Marketplace ID to endpoint mapping */
const MARKETPLACE_ENDPOINTS: Record<string, string> = {
  'ATVPDKIKX0DER': 'https://sellingpartnerapi-na.amazon.com',  // US
  'A2EUQ1WTGCTBG2': 'https://sellingpartnerapi-na.amazon.com', // CA
  'A1AM78C64UM0Y8': 'https://sellingpartnerapi-na.amazon.com', // MX
  'A2Q3Y263D00KWC': 'https://sellingpartnerapi-na.amazon.com', // BR
  'A1RKKUPIHCS9HS': 'https://sellingpartnerapi-eu.amazon.com',  // ES
  'A1F83G8C2ARO7P': 'https://sellingpartnerapi-eu.amazon.com',  // UK
  'A13V1IB3VIYZZH': 'https://sellingpartnerapi-eu.amazon.com',  // FR
  'APJ6JRA9NG5V4':  'https://sellingpartnerapi-eu.amazon.com',  // IT
  'A1PA6795UKMFR9': 'https://sellingpartnerapi-eu.amazon.com',  // DE
  'A1805IZSGTT6HS': 'https://sellingpartnerapi-eu.amazon.com',  // NL
  'A19VAU5U5O7RUS': 'https://sellingpartnerapi-fe.amazon.com',  // SG
  'A39IBJ37TRP1C6': 'https://sellingpartnerapi-fe.amazon.com',  // AU
  'A1VC38T7YXB528': 'https://sellingpartnerapi-fe.amazon.com',  // JP
};

export function getEndpoint(marketplaceId: string, sandbox: boolean = false): string {
  const base = MARKETPLACE_ENDPOINTS[marketplaceId] || 'https://sellingpartnerapi-na.amazon.com';
  return sandbox ? base.replace('sellingpartnerapi', 'sandbox.sellingpartnerapi') : base;
}

/**
 * Make an authenticated SP-API request.
 * Handles token refresh, rate limiting (429), and retries.
 */
export async function spApiRequest(
  credentials: SPAPICredentials,
  path: string,
  params?: Record<string, string>,
  retries: number = 3,
  sandbox: boolean = false
): Promise<any> {
  const endpoint = getEndpoint(credentials.marketplaceId, sandbox);
  const limiter = getEndpointLimiter(path);

  const url = new URL(path, endpoint);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  for (let attempt = 0; attempt < retries; attempt++) {
    await limiter.wait();
    const accessToken = await getAccessToken(credentials);

    const response = await fetch(url.toString(), {
      headers: {
        'x-amz-access-token': accessToken,
        'Content-Type': 'application/json',
      },
    });

    if (response.ok) {
      if (attempt > 0) {
        console.log(`SP-API ${path} recovered on attempt ${attempt + 1}/${retries}`);
      }
      return response.json();
    }

    // Rate limited — wait with exponential backoff and retry
    if (response.status === 429) {
      const baseWait = getRetryAfterSeconds(response.headers.get('Retry-After'), 3);
      const waitTime = baseWait * Math.pow(2, attempt); // 3s, 6s, 12s, 24s, 48s
      limiter.recordThrottle(waitTime * 1000);
      console.warn(`SP-API 429 on ${path}, retrying in ${waitTime}s (attempt ${attempt + 1}/${retries})`);
      await sleep(waitTime * 1000);
      continue;
    }

    // Server error — retry with backoff
    if (response.status >= 500) {
      const waitTime = 5 * Math.pow(2, attempt);
      console.warn(`SP-API ${response.status} on ${path}, retrying in ${waitTime}s (attempt ${attempt + 1}/${retries})`);
      await sleep(waitTime * 1000);
      continue;
    }

    // Token expired — refresh and retry once
    if (response.status === 403 && attempt === 0) {
      clearTokenCache();
      continue;
    }

    const errorBody = await response.text();
    throw new Error(`SP-API ${response.status} on ${path}: ${errorBody}`);
  }

  throw new Error(`SP-API request failed after ${retries} retries: ${path}`);
}

/**
 * Test the connection by making a simple API call.
 * Uses the Orders API to get a single order (lightweight call).
 */
export async function testConnection(credentials: SPAPICredentials, sandbox: boolean = false): Promise<{ success: boolean; error?: string; mode?: string }> {
  try {
    // First just test the token exchange works
    const token = await getAccessToken(credentials);
    if (!token) throw new Error('No access token received');

    // Try production first, fall back to sandbox
    try {
      await spApiRequest(credentials, '/sellers/v1/marketplaceParticipations', undefined, 1, false);
      return { success: true, mode: 'production' };
    } catch {
      // Try sandbox endpoint
      await spApiRequest(credentials, '/sellers/v1/marketplaceParticipations', undefined, 1, true);
      return { success: true, mode: 'sandbox' };
    }
  } catch (error) {
    // If both fail but token exchange worked, that's still a partial success
    try {
      await getAccessToken(credentials);
      return { success: true, mode: 'token-only', error: 'Token exchange works but API access pending. You may need to verify your identity to unlock Production access.' };
    } catch (tokenError) {
      return { success: false, error: String(tokenError) };
    }
  }
}
