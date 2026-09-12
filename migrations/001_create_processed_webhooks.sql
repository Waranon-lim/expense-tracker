CREATE TABLE processed_webhooks (
    id                       BIGSERIAL PRIMARY KEY,
    provider                 TEXT NOT NULL DEFAULT 'mock_bank',
    provider_transaction_id  TEXT NOT NULL,
    status                   TEXT NOT NULL DEFAULT 'received'
                             CHECK (status IN ('received', 'processing', 'completed', 'failed')),
    payload                  JSONB NOT NULL,
    error_message            TEXT,
    processed_at             TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_processed_webhooks_provider_txn UNIQUE (provider, provider_transaction_id)
);

CREATE INDEX idx_processed_webhooks_status ON processed_webhooks (status);
