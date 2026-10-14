-- Prevents "Food" and "food" from being registered as separate categories
-- (splitting totals between them); finalizeCategory upserts against this index.
CREATE UNIQUE INDEX categories_name_lower_idx ON categories (lower(trim(name)));
