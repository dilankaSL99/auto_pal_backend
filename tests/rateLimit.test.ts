import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { rateLimit } from '../src/middleware/rateLimit';

// Minimal fake req/res so the limiter can be exercised without a live server.
function fakeReq(ip = '1.2.3.4'): Request {
  return { ip, socket: { remoteAddress: ip }, headers: {} } as unknown as Request;
}
function fakeRes(): Response & { statusCode?: number; body?: unknown } {
  const res: Partial<Response> & { statusCode?: number; body?: unknown } = {};
  res.setHeader = vi.fn() as unknown as Response['setHeader'];
  res.status = ((code: number) => {
    res.statusCode = code;
    return res as Response;
  }) as Response['status'];
  res.json = ((payload: unknown) => {
    res.body = payload;
    return res as Response;
  }) as Response['json'];
  return res as Response & { statusCode?: number; body?: unknown };
}

describe('rateLimit middleware', () => {
  it('allows up to `max` requests then returns 429', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 5 });
    const req = fakeReq();

    let allowed = 0;
    let blocked = 0;
    for (let i = 0; i < 7; i++) {
      const res = fakeRes();
      const next = vi.fn();
      mw(req, res, next);
      if (next.mock.calls.length > 0) allowed++;
      if (res.statusCode === 429) blocked++;
    }

    expect(allowed).toBe(5);
    expect(blocked).toBe(2);
  });

  it('tracks limits per IP independently', () => {
    const mw = rateLimit({ windowMs: 60_000, max: 1 });

    const resA = fakeRes();
    const nextA = vi.fn();
    mw(fakeReq('10.0.0.1'), resA, nextA);
    expect(nextA).toHaveBeenCalled();

    // Different IP still gets its own fresh allowance.
    const resB = fakeRes();
    const nextB = vi.fn();
    mw(fakeReq('10.0.0.2'), resB, nextB);
    expect(nextB).toHaveBeenCalled();

    // Same IP as A is now over the limit.
    const resA2 = fakeRes();
    const nextA2 = vi.fn();
    mw(fakeReq('10.0.0.1'), resA2, nextA2);
    expect(nextA2).not.toHaveBeenCalled();
    expect(resA2.statusCode).toBe(429);
  });
});
