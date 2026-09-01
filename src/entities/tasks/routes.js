import { pool } from "../../db.js";
import { crudRouter, wrap } from "../../lib/crud.js";
import tasks from "./config.js";
import items from "../items/config.js";

// Generic routes plus GET/POST /tasks/:id/items; GET /tasks/:id embeds `items: [...]`.
const router = crudRouter(tasks, { children: [items] });

// Entity-specific route: mark a task done.
router.post("/:id/done", wrap(async (req, res) => {
  const { rows } = await pool.query(
    "UPDATE tasks SET done = TRUE, updated_at = NOW() WHERE id = $1 RETURNING *",
    [req.params.id]
  );
  rows.length ? res.json(rows[0]) : res.status(404).json({ error: `tasks ${req.params.id} not found` });
}));

export default router;
