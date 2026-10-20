import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { requireUser } from '../middleware/requireUser';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../services/passwordHash';
import { createSession, deleteSession } from '../services/sessions';
import { countUsers, createUser, findUserByEmail } from '../services/users';
import { SESSION_COOKIE, buildClearCookie, buildSessionCookie, parseCookies } from '../utils/cookies';
import { loginRateLimiter } from '../utils/loginRateLimit';
import { isSignupOpen } from '../utils/signupSetting';
import { LoginSchema, SignupSchema } from '../validation/authSchema';

export const authRouter = Router();

const secureCookies = () => process.env.NODE_ENV === 'production';

// A wrong email and a wrong password give the same message, so the answer does
// not reveal which emails have accounts.
const WRONG_LOGIN = 'Wrong email or password';

authRouter.post(
  '/signup',
  asyncHandler(async (req, res) => {
    const parsed = SignupSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    const { email, password, remember } = parsed.data;

    // ALLOW_SIGNUP=false closes sign-up, but the very first account must always
    // be possible, otherwise nobody could ever sign in.
    if (!isSignupOpen(process.env.ALLOW_SIGNUP) && (await countUsers(pool)) > 0) {
      res.status(403).json({ error: 'Sign-up is closed' });
      return;
    }

    const user = await createUser(pool, email, await hashPassword(password));
    if (!user) {
      res.status(409).json({ error: 'An account with this email already exists' });
      return;
    }

    const session = await createSession(pool, user.id, remember);
    res.setHeader('Set-Cookie', buildSessionCookie(session.token, { maxAgeSeconds: session.maxAgeSeconds, secure: secureCookies() }));
    res.status(201).json({ id: user.id, email: user.email });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const parsed = LoginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }
    const { email, password, remember } = parsed.data;

    const limitKey = `${email}|${req.ip}`;
    if (loginRateLimiter.isBlocked(limitKey)) {
      res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
      return;
    }
    // Count the attempt BEFORE the slow password check. This check and the count
    // run in one step, so many parallel requests cannot all slip past the limit
    // while the first ones are still hashing. A successful login clears the count.
    loginRateLimiter.recordFailure(limitKey);

    const user = await findUserByEmail(pool, email);
    let passwordOk = false;
    if (user) {
      passwordOk = await verifyPassword(password, user.password_hash);
    } else {
      await burnPasswordCheck(password);
    }

    if (!user || !passwordOk) {
      res.status(401).json({ error: WRONG_LOGIN });
      return;
    }

    loginRateLimiter.clear(limitKey);
    const session = await createSession(pool, user.id, remember);
    res.setHeader('Set-Cookie', buildSessionCookie(session.token, { maxAgeSeconds: session.maxAgeSeconds, secure: secureCookies() }));
    res.status(200).json({ id: user.id, email: user.email });
  }),
);

authRouter.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) await deleteSession(pool, token);
    res.setHeader('Set-Cookie', buildClearCookie(secureCookies()));
    res.status(200).json({ signedOut: true });
  }),
);

authRouter.get('/me', requireUser, (req, res) => {
  res.status(200).json({ id: req.userId, email: req.userEmail });
});
