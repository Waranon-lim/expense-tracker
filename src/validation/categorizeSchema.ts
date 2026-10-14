import { z } from 'zod';

export const CategorizeRequestSchema = z.object({
  category: z.string().trim().min(1).max(40),
});

export type CategorizeRequest = z.infer<typeof CategorizeRequestSchema>;
