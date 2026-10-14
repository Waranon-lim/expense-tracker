import type { NextFunction, Request, RequestHandler, Response } from 'express';

// Express 4 doesn't await handlers, so a rejected promise from an async route
// handler becomes an unhandled rejection instead of an error response — and
// on modern Node that crashes the whole process over a single bad query.
// Wrapping every async handler in this forwards the rejection to next(),
// landing it on Express's error handler instead.
export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}
