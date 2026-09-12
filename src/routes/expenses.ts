import { Router } from 'express';
import { pool } from '../db/pool';
import { CategorizeRequestSchema } from '../validation/categorizeSchema';
import { finalizeCategory } from '../services/categorizationFinalizer';

export const expensesRouter = Router();

expensesRouter.get('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid expense id' });
    return;
  }

  const result = await pool.query('SELECT * FROM expenses WHERE id = $1', [id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: 'Expense not found' });
    return;
  }

  res.status(200).json(result.rows[0]);
});

// Simulates the user tapping a category on the push-notification prompt.
expensesRouter.post('/:id/categorize', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    res.status(400).json({ error: 'Invalid expense id' });
    return;
  }

  const parseResult = CategorizeRequestSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({ error: 'Invalid request', details: parseResult.error.flatten() });
    return;
  }

  const { applied } = await finalizeCategory(pool, id, parseResult.data.category, 'user');

  if (!applied) {
    const existing = await pool.query('SELECT status FROM expenses WHERE id = $1', [id]);
    if (existing.rowCount === 0) {
      res.status(404).json({ error: 'Expense not found' });
      return;
    }
    res.status(409).json({ error: 'Expense is already categorized' });
    return;
  }

  res.status(200).json({ status: 'categorized', category: parseResult.data.category });
});
