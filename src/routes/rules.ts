import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { requireApiKey } from '../middleware/requireApiKey';
import { DEMO_USER_ID } from '../constants';

export const rulesRouter = Router();

// What the app has learned: one row per merchant the user has categorized.
rulesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      `SELECT merchant_key, category FROM merchant_rules WHERE user_id = $1 ORDER BY merchant_key`,
      [DEMO_USER_ID],
    );
    res.status(200).json(result.rows);
  }),
);

// Forgets one rule; that merchant goes back to the built-in guess.
// The key is URL-encoded by the client because it can contain spaces/Thai text.
rulesRouter.delete(
  '/:key',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const result = await pool.query('DELETE FROM merchant_rules WHERE user_id = $1 AND merchant_key = $2', [
      DEMO_USER_ID,
      req.params.key,
    ]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    res.status(204).end();
  }),
);
