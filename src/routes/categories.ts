import { Router } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { z } from 'zod';
import { requireUser } from '../middleware/requireUser';

export const categoriesRouter = Router();

// Every query below is limited to the signed-in user's own categories.
categoriesRouter.get(
  '/',
  requireUser,
  asyncHandler(async (req, res) => {
    const result = await pool.query(
      `SELECT id, name, color, is_default FROM categories WHERE user_id = $1 ORDER BY is_default DESC, name ASC`,
      [req.userId],
    );
    res.status(200).json(result.rows);
  }),
);

// Removes a category from the picker/filter options. Doesn't touch any
// expenses already using it — their `category` text column is untouched,
// this only stops it being offered for *future* categorization.
categoriesRouter.delete(
  '/:id',
  requireUser,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid category id' });
      return;
    }

    const existing = await pool.query('SELECT is_default FROM categories WHERE id = $1 AND user_id = $2', [id, req.userId]);
    if (existing.rowCount === 0) {
      res.status(404).json({ error: 'Category not found' });
      return;
    }
    if (existing.rows[0].is_default) {
      res.status(403).json({ error: 'Cannot delete a default category' });
      return;
    }

    await pool.query('DELETE FROM categories WHERE id = $1 AND user_id = $2', [id, req.userId]);
    res.status(200).json({ deleted: true });
  }),
);

const UpdateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Color must look like #1a2b3c').optional(),
  })
  .refine((v) => v.name !== undefined || v.color !== undefined, { message: 'Nothing to change' });

// Edits a category's name and/or color. Default categories keep their name
// (the built-in merchant guesses refer to "Food"/"Transport"/"Other" by name)
// but can be recolored. A rename also rewrites the old name on this user's
// existing expenses and learned rules, otherwise they would point at a category
// that no longer exists. Other users' data is never touched.
categoriesRouter.patch(
  '/:id',
  requireUser,
  asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) {
      res.status(400).json({ error: 'Invalid category id' });
      return;
    }
    const parsed = UpdateCategorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid request', details: parsed.error.flatten() });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT name, is_default FROM categories WHERE id = $1 AND user_id = $2 FOR UPDATE',
        [id, req.userId],
      );
      if (existing.rowCount === 0) {
        await client.query('ROLLBACK');
        res.status(404).json({ error: 'Category not found' });
        return;
      }
      const oldName = existing.rows[0].name as string;
      const newName = parsed.data.name ?? oldName;
      const renaming = newName !== oldName;

      if (renaming && existing.rows[0].is_default) {
        await client.query('ROLLBACK');
        res.status(403).json({ error: 'Default categories can be recolored but not renamed' });
        return;
      }

      try {
        await client.query('UPDATE categories SET name = $1, color = COALESCE($2, color) WHERE id = $3 AND user_id = $4', [
          newName,
          parsed.data.color ?? null,
          id,
          req.userId,
        ]);
      } catch (err) {
        // 23505 = unique violation from categories_user_name_lower_idx (case-insensitive, per user).
        if ((err as { code?: string }).code === '23505') {
          await client.query('ROLLBACK');
          res.status(409).json({ error: `A category named "${newName}" already exists` });
          return;
        }
        throw err;
      }

      if (renaming) {
        await client.query('UPDATE expenses SET category = $1 WHERE category = $2 AND user_id = $3', [newName, oldName, req.userId]);
        await client.query('UPDATE merchant_rules SET category = $1 WHERE category = $2 AND user_id = $3', [newName, oldName, req.userId]);
      }
      await client.query('COMMIT');

      const updated = await pool.query('SELECT id, name, color, is_default FROM categories WHERE id = $1 AND user_id = $2', [id, req.userId]);
      res.status(200).json(updated.rows[0]);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }),
);
