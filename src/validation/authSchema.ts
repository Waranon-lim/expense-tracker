import { z } from 'zod';

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(8).max(200);

export const SignupSchema = z.object({
  email,
  password,
  remember: z.boolean().optional().default(false),
});

export const LoginSchema = z.object({
  email,
  password,
  remember: z.boolean().optional().default(false),
});

export type SignupRequest = z.infer<typeof SignupSchema>;
export type LoginRequest = z.infer<typeof LoginSchema>;
