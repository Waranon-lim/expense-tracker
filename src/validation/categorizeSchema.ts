import { z } from 'zod';

export const CategorizeRequestSchema = z.object({
  category: z.string().min(1),
});

export type CategorizeRequest = z.infer<typeof CategorizeRequestSchema>;
