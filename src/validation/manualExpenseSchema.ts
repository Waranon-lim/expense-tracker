import { z } from 'zod';

// '2026-02-31' matches the shape but is not a real day. Round-tripping through
// Date catches it, because Date rolls it over to March.
function isRealCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const ManualExpenseRequestSchema = z.object({
  merchant: z.string().trim().min(1).max(100),
  // expenses.amount is NUMERIC(12, 2): 2 decimal places. The tolerance covers
  // binary floating point (12.1 * 100 is 1210.0000000000002).
  amount: z
    .number()
    .positive()
    .max(10_000_000)
    .refine((value) => Math.abs(value * 100 - Math.round(value * 100)) < 1e-6, 'At most 2 decimal places'),
  category: z.string().trim().min(1).max(40),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealCalendarDate, 'Not a real calendar date')
    .optional(),
  currency: z
    .string()
    .trim()
    .regex(/^[A-Za-z]{3}$/)
    .transform((value) => value.toUpperCase())
    .default('THB'),
});

export type ManualExpenseRequest = z.infer<typeof ManualExpenseRequestSchema>;
