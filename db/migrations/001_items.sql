CREATE TABLE IF NOT EXISTS items (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed rows, only when the table is empty (safe on databases created by the old init.sql).
INSERT INTO items (name, description)
SELECT * FROM (VALUES
  ('First item',  'Seeded by migration 001'),
  ('Second item', 'Edit or delete me via the API')
) AS seed(name, description)
WHERE NOT EXISTS (SELECT 1 FROM items);
