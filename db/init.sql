-- Runs automatically the FIRST time the postgres container starts with an
-- empty data volume (see /docker-entrypoint-initdb.d in compose.yaml).
CREATE TABLE IF NOT EXISTS items (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO items (name, description) VALUES
  ('First item',  'Seeded on database initialisation'),
  ('Second item', 'Edit or delete me via the API');
