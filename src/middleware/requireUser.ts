import type { NextFunction, Request, Response } from 'express';
import { pool } from '../db/pool';
import { findSessionUser } from '../services/sessions';
import { SESSION_COOKIE, parseCookies } from '../utils/cookies';

// Adds the signed-in user to the request type. Every route that uses
// requireUser can rely on these being set.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId: string;
      userEmail: string;
    }
  }
}

// Replaces requireApiKey. Reads the session cookie, finds a live session, and
// puts the user on the request. No cookie or no live session gives 401.
export async function requireUser(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const user = token ? await findSessionUser(pool, token) : null;
    if (!user) {
      res.status(401).json({ error: 'Not signed in' });
      return;
    }
    req.userId = user.id;
    req.userEmail = user.email;
    next();
  } catch (err) {
    next(err);
  }
}
