import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { requireUser } from '../middleware/requireUser';

export const rulesRouter = Router();

// What the app has learned: one row per merchant the user has categorized.
rulesRouter.get(
  '/',
  requireUser,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT merchant_key, category FROM merchant_rules WHERE user_id = $1 ORDER BY merchant_key`,
      [req.userId],
    );
    res.status(200).json(result.rows);
  }),
);

// Forgets one rule; that merchant goes back to the built-in guess.
// The key is URL-encoded by the client because it can contain spaces/Thai text.
rulesRouter.delete(
  '/:key',
  requireUser,
  asyncHandler(async (req, res) => {
    const result = await pool.query('DELETE FROM merchant_rules WHERE user_id = $1 AND merchant_key = $2', [
      req.userId,
      req.params.key,
    ]);
    if (result.rowCount === 0) {
      res.status(404).json({ error: 'Rule not found' });
      return;
    }
    res.status(204).end();
  }),
);
