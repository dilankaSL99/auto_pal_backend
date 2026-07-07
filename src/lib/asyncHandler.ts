import type { NextFunction, Request, Response } from 'express';

type AsyncFn = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

// Wraps an async route handler so any rejected promise is forwarded to the
// Express error middleware instead of crashing the process.
export const asyncHandler =
  (fn: AsyncFn) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
