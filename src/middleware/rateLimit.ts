import type { NextFunction, Request, Response } from 'express';

// Lightweight, dependency-free fixed-window rate limiter.
//
// Keeps per-key hit counts in an in-memory Map and resets each key when its
// window expires. This is intentionally simple: it protects a single process
// against brute-force / abuse bursts without pulling in a new dependency. For a
// horizontally-scaled deployment, back this with a shared store (e.g. Redis)
// instead — the middleware shape stays the same.

interface Bucket {
  count: number;
  resetAt: number;
}

interface Options {
  windowMs: number;
  max: number;
  message?: string;
}

export function rateLimit({ windowMs, max, message }: Options) {
  const hits = new Map<string, Bucket>();

  // Periodically drop expired buckets so the Map can't grow unbounded.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) hits.delete(key);
    }
  }, windowMs);
  sweep.unref?.();

  return function rateLimiter(req: Request, res: Response, next: NextFunction) {
    // req.ip respects Express's trust-proxy setting; by default it is the direct
    // socket address, which cannot be spoofed via X-Forwarded-For.
    const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const now = Date.now();

    let bucket = hits.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      hits.set(key, bucket);
    }

    bucket.count += 1;

    const remaining = Math.max(0, max - bucket.count);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.resetAt - now) / 1000)));

    if (bucket.count > max) {
      const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({
        error: {
          code: 'TOO_MANY_REQUESTS',
          message: message ?? 'Too many requests, please try again later.',
        },
      });
      return;
    }

    next();
  };
}
