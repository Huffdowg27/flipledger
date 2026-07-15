import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CROSS_ORIGIN_API_KEY_ROUTE = '/api/extension/veeqo-context';

function isSameOriginMutation(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (origin !== null) {
    if (origin === 'null') return false;
    try {
      const parsedOrigin = new URL(origin);
      const requestHost = request.headers.get('x-forwarded-host')
        || request.headers.get('host')
        || request.nextUrl.host;
      const requestProtocol = request.headers.get('x-forwarded-proto')
        || request.nextUrl.protocol.replace(/:$/, '');
      return parsedOrigin.host === requestHost
        && parsedOrigin.protocol === `${requestProtocol}:`;
    } catch {
      return false;
    }
  }

  // Browser Fetch Metadata is a second signal for requests where Origin was
  // omitted. Requests from trusted local scripts/curl have neither header and
  // remain supported because Flip Ledger also uses command-line maintenance.
  return request.headers.get('sec-fetch-site') !== 'cross-site';
}

/**
 * Next.js 16 renamed Middleware to Proxy. Keep the guard at the API boundary so
 * every present and future mutating route is covered by default.
 * Source: https://nextjs.org/docs/app/api-reference/file-conventions/proxy
 */
export function proxy(request: NextRequest): NextResponse {
  if (
    SAFE_METHODS.has(request.method)
    || request.nextUrl.pathname === CROSS_ORIGIN_API_KEY_ROUTE
    || isSameOriginMutation(request)
  ) {
    return NextResponse.next();
  }

  console.warn(JSON.stringify({
    event: 'cross_origin_mutation_blocked',
    method: request.method,
    path: request.nextUrl.pathname,
    origin: request.headers.get('origin'),
    fetchSite: request.headers.get('sec-fetch-site'),
  }));
  return NextResponse.json(
    { error: 'Cross-origin mutation blocked' },
    { status: 403 },
  );
}

export const config = {
  matcher: '/api/:path*',
};
