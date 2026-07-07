import type { NextFunction, Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { env } from '../env';
import { ApiError } from '../lib/errors';

// 404 for anything that fell through the router.
export function notFoundHandler(_req: Request, _res: Response, next: NextFunction) {
  next(ApiError.notFound('Route not found'));
}

// Central error middleware — the single place that shapes error responses.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details: unknown;

  if (err instanceof ApiError) {
    status = err.statusCode;
    code = err.code;
    message = err.message;
    details = err.details;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // Map the common Prisma errors to friendly HTTP responses.
    if (err.code === 'P2002') {
      status = 409;
      code = 'CONFLICT';
      const target = (err.meta?.target as string[] | undefined)?.join(', ');
      message = target ? `A record with this ${target} already exists` : 'Duplicate value';
    } else if (err.code === 'P2025') {
      status = 404;
      code = 'NOT_FOUND';
      message = 'Record not found';
    } else {
      status = 400;
      code = 'DB_ERROR';
      message = 'Database request error';
    }
  } else if (err instanceof Error) {
    message = err.message;
  }

  if (status >= 500) {
    // eslint-disable-next-line no-console
    console.error(err);
  }

  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      ...(env.NODE_ENV === 'development' && status >= 500 && err instanceof Error
        ? { stack: err.stack }
        : {}),
    },
  });
}
