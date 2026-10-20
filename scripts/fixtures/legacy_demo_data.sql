-- One expense and one learned rule that belong to the old demo user, so the
-- smoke test can check that the first account takes them over.
WITH w AS (
  INSERT INTO processed_webhooks (provider, provider_transaction_id, status, payload)
  VALUES ('mock_bank', 'legacy_test_1', 'completed', '{}')
  RETURNING id
)
INSERT INTO expenses (
  user_id, amount, currency, merchant, category, raw_bank_category, status,
  category_source, source, webhook_id, transaction_date, received_at, categorized_at
)
SELECT 'usr_demo_1', 99, 'THB', 'LEGACY TEST Coffee', 'Food', 'COFFEE', 'categorized',
       'mapping', 'bank_webhook', w.id, now(), now(), now()
FROM w;

INSERT INTO merchant_rules (user_id, merchant_key, category)
VALUES ('usr_demo_1', 'legacy test coffee', 'Food');
