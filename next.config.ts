import type { NextConfig } from "next";

const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https:",
  "font-src 'self' data:",
  "connect-src 'self' https://cdn.jsdelivr.net",
  "worker-src 'self' blob:",
].join("; ");

const nextConfig: NextConfig = {
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
  // Static response headers are the documented Next.js pattern when a
  // per-request CSP nonce is unnecessary.
  // Source: https://nextjs.org/docs/app/api-reference/config/next-config-js/headers
  async headers() {
    return [{
      source: "/(.*)",
      headers: [
        { key: "Content-Security-Policy", value: contentSecurityPolicy },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        {
          key: "Permissions-Policy",
          value: "camera=(), microphone=(), geolocation=()",
        },
      ],
    }];
  },
};

export default nextConfig;
