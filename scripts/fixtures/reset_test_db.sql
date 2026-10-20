-- Empties the TEST database. Refuses to run on any other database.
-- Run with: psql -v ON_ERROR_STOP=1 -d expense_tracker_test -f this file
BEGIN;

DO $$
BEGIN
  IF current_database() <> 'expense_tracker_test' THEN
    RAISE EXCEPTION 'Refusing to reset database %', current_database();
  END IF;
END $$;

TRUNCATE users, sessions, expenses, processed_webhooks, merchant_rules, push_subscriptions RESTART IDENTITY CASCADE;
DELETE FROM categories;
INSERT INTO categories (user_id, name, color, is_default) VALUES
  ('usr_demo_1', 'Food', '#16a34a', true),
  ('usr_demo_1', 'Transport', '#2563eb', true),
  ('usr_demo_1', 'Other', '#64748b', true);

COMMIT;
