-- Manual expenses have no bank webhook, so webhook_id can be empty.
-- The CHECK keeps the old guarantee for bank rows: they must still link to a webhook.
ALTER TABLE expenses ALTER COLUMN webhook_id DROP NOT NULL;

ALTER TABLE expenses ADD CONSTRAINT expenses_bank_webhook_requires_webhook
  CHECK (source <> 'bank_webhook' OR webhook_id IS NOT NULL);
