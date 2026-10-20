-- Accounts, sessions, and per-user categories.
-- The whole file is one transaction: if any line fails, nothing changes.
BEGIN;

CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));

-- Only the SHA-256 hash of the session token is stored, so a leaked database
-- does not give out working sessions.
CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

-- Categories were shared by everyone. Every existing row belongs to the demo
-- user, who becomes the first account (id usr_demo_1).
ALTER TABLE categories ADD COLUMN user_id TEXT;
UPDATE categories SET user_id = 'usr_demo_1';
ALTER TABLE categories ALTER COLUMN user_id SET NOT NULL;

ALTER TABLE categories DROP CONSTRAINT categories_name_key;
DROP INDEX categories_name_lower_idx;
CREATE UNIQUE INDEX categories_user_name_lower_idx ON categories (user_id, lower(trim(name)));

COMMIT;
