import { z } from 'zod';

export const BankWebhookPayloadSchema = z.object({
  transaction_id: z.string().min(1),
  user_id: z.string().min(1),
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'Currency must be a 3-letter uppercase ISO 4217 code'),
  merchant_name: z.string().min(1).max(200),
  bank_category: z.string().min(1),
  timestamp: z.string().datetime(),
});

export type BankWebhookPayload = z.infer<typeof BankWebhookPayloadSchema>;
