CREATE TABLE tasks (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  due_at      TIMESTAMPTZ,
  done        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- items become children of tasks; deleting a task deletes its items.
ALTER TABLE items
  ADD COLUMN task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE;

CREATE INDEX items_task_id_idx ON items (task_id);
