/** HTTP hardening helpers shared by every module */

/** Strict security headers; The UI is fully self-hosted, so 'self' is enough */
export function securityHeaders(req, res, next) {
  const host = req.headers.host || '';
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'", // xterm.js injects runtime <style> rules
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self' ws://${host} wss://${host}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
}

/**
 * WebSocket upgrades are not covered by CORS, so a malicious page could open a
 * terminal on behalf of a visitor (cross-site WebSocket hijacking)
 * Only accept the platform's own origin, plus explicitly configured ones
 */
export function isOriginAllowed(req, allowedOrigins = []) {
  const origin = req.headers.origin;
  if (!origin) return false;
  if (allowedOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Fixed-window rate limiter keyed by client (IP) */
export function createRateLimiter({ limit, windowMs }) {
  const hits = new Map();
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (now - v.start > windowMs) hits.delete(k);
  }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
