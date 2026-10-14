CREATE TABLE categories (
    id         BIGSERIAL PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO categories (name, color, is_default) VALUES
    ('Food', '#16a34a', true),
    ('Transport', '#2563eb', true),
    ('Other', '#64748b', true);
