import express from "express";
import { pool } from "./db.js";

const app = express();
app.use(express.json()); // parse JSON request bodies

// Used by the Dockerfile HEALTHCHECK and by Compose's depends_on condition.
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "db unavailable", error: err.message });
  }
});

// ---- CRUD for a single "items" resource ----

// CREATE
app.post("/items", async (req, res) => {
  const { name, description = "" } = req.body ?? {};
  if (!name) return res.status(400).json({ error: "name is required" });
  const { rows } = await pool.query(
    "INSERT INTO items (name, description) VALUES ($1, $2) RETURNING *",
    [name, description]
  );
  res.status(201).json(rows[0]);
});

// READ (all)
app.get("/items", async (_req, res) => {
  const { rows } = await pool.query("SELECT * FROM items ORDER BY id");
  res.json(rows);
});

// READ (one)
app.get("/items/:id", async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM items WHERE id = $1", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// UPDATE
app.put("/items/:id", async (req, res) => {
  const { name, description } = req.body ?? {};
  const { rows } = await pool.query(
    `UPDATE items
       SET name = COALESCE($1, name),
           description = COALESCE($2, description),
           updated_at = NOW()
     WHERE id = $3
     RETURNING *`,
    [name, description, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: "not found" });
  res.json(rows[0]);
});

// DELETE
app.delete("/items/:id", async (req, res) => {
  const { rowCount } = await pool.query("DELETE FROM items WHERE id = $1", [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: "not found" });
  res.status(204).end();
});

// Central error handler so a bad query returns JSON instead of crashing.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`API listening on http://0.0.0.0:${port}`)
);

// Graceful shutdown: `docker compose down` sends SIGTERM; finish in-flight
// requests, close DB connections, then exit so Docker doesn't have to SIGKILL.
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
