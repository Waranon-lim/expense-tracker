import type { BankWebhookPayload } from '../validation/webhookSchema';

export type WebhookStatus = 'received' | 'processing' | 'completed' | 'failed';

export interface ProcessedWebhookRow {
  id: number;
  provider: string;
  provider_transaction_id: string;
  status: WebhookStatus;
  payload: BankWebhookPayload;
  error_message: string | null;
  processed_at: string | null;
  created_at: string;
}

export type ExpenseStatus = 'pending' | 'categorized';
export type CategorySource = 'user' | 'default' | 'mapping' | null;

export interface ExpenseRow {
  id: number;
  user_id: string;
  amount: number;
  currency: string;
  merchant: string;
  category: string | null;
  raw_bank_category: string;
  status: ExpenseStatus;
  category_source: CategorySource;
  source: string;
  webhook_id: number;
  transaction_date: string;
  received_at: string;
  categorized_at: string | null;
  created_at: string;
  updated_at: string;
}

export type { BankWebhookPayload };
