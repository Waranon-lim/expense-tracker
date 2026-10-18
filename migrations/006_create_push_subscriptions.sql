-- One row per browser/phone that turned notifications on.
-- endpoint is the push service URL (unique per device); p256dh/auth are the
-- keys the push service needs us to encrypt each message with.
CREATE TABLE push_subscriptions (
    endpoint   TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    p256dh     TEXT NOT NULL,
    auth       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
