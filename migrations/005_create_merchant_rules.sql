-- What the user has taught the app: "this merchant is usually this category".
-- merchant_key is the normalized merchant name (see normalizeMerchant()).
CREATE TABLE merchant_rules (
    user_id      TEXT NOT NULL,
    merchant_key TEXT NOT NULL,
    category     TEXT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, merchant_key)
);
