import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { requireApiKey } from '../middleware/requireApiKey';

export const categoriesRouter = Router();

categoriesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const result = await pool.query(
      `SELECT id, name, color, is_default FROM categories ORDER BY is_default DESC, name ASC`,
    );
    res.status(200).json(result.rows);
  }),
);

// Removes a category from the picker/filter options. Doesn't touch any
// expenses already using it — their `category` text column is untouched,
// this only stops it being offered for *future* categorization.
categoriesRouter.delete(
  '/:id',
  requireApiKey,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid category id' });
      return;
    }

    const existing = await pool.query('SELECT is_default FROM categories WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    if (existing.rows[0].is_default) {
      res.status(403).json({ error: 'Cannot delete a default category' });
      return;
    }

    await pool.query('DELETE FROM categories WHERE id = $1', [id]);
    res.status(200).json({ deleted: true });
  }),
);
