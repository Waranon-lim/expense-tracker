CREATE TABLE expenses (
    id                 BIGSERIAL PRIMARY KEY,
    user_id            TEXT NOT NULL,
    amount             NUMERIC(12, 2) NOT NULL,
    currency           CHAR(3) NOT NULL,
    merchant           TEXT NOT NULL,
    category           TEXT,
    raw_bank_category  TEXT NOT NULL,
    status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'categorized')),
    category_source    TEXT
                       CHECK (category_source IN ('user', 'default', 'mapping')),
    source             TEXT NOT NULL DEFAULT 'bank_webhook',
    webhook_id         BIGINT NOT NULL REFERENCES processed_webhooks(id),
    transaction_date   TIMESTAMPTZ NOT NULL,
    received_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    categorized_at     TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_expenses_user_id ON expenses (user_id);
CREATE INDEX idx_expenses_webhook_id ON expenses (webhook_id);
CREATE INDEX idx_expenses_pending ON expenses (received_at) WHERE status = 'pending';
