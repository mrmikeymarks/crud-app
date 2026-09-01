import { Router } from "express";
import { pool } from "../db.js";

// Table and column names are interpolated into SQL, so they must be plain identifiers.
// Values never are: they always travel as $1, $2, ... parameters.
const IDENT = /^[a-z_][a-z0-9_]*$/;
const ident = (s) => {
  if (!IDENT.test(s)) throw new Error(`invalid SQL identifier: ${s}`);
  return s;
};
// Ids, limit and offset must fit Postgres int4; anything larger is a client error, not a 500.
const isId = (v) => /^\d{1,10}$/.test(String(v)) && Number(v) <= 2147483647;

// Express 4 does not catch rejected promises; forward them to the error handler.
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

const notFound = (res, table, id) => res.status(404).json({ error: `${table} ${id} not found` });

export const MAX_LIMIT = 500;
function pagination({ limit = 100, offset = 0 }) {
  if (!isId(limit) || Number(limit) < 1) return { error: `limit must be 1..${MAX_LIMIT}` };
  if (!isId(offset)) return { error: "offset must be a non-negative integer" };
  return { limit: Math.min(Number(limit), MAX_LIMIT), offset: Number(offset) };
}

async function exists(table, id) {
  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  return rowCount > 0;
}

// Columns an entity allows clients to write (its own plus the parent key, if any).
const writable = (entity) => (entity.parent ? [...entity.columns, entity.parent.key] : entity.columns);

// Keep only the writable columns present in the request body.
function pick(entity, body) {
  return Object.fromEntries(writable(entity).filter((c) => body && c in body).map((c) => [c, body[c]]));
}

// Returns an error string, or null when `data` is acceptable for insert/update.
function validate(entity, data, { creating }) {
  const required = entity.required ?? [];
  const missing = required.filter((c) =>
    creating ? data[c] == null || data[c] === "" : c in data && (data[c] == null || data[c] === "")
  );
  if (missing.length) return `${missing.join(", ")} required`;
  if (entity.parent && data[entity.parent.key] != null && !isId(data[entity.parent.key]))
    return `${entity.parent.key} must be an integer id`;
  return null;
}

async function insert(entity, data) {
  const keys = Object.keys(data);
  const sql = keys.length
    ? `INSERT INTO ${entity.table} (${keys.join(", ")}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`
    : `INSERT INTO ${entity.table} DEFAULT VALUES RETURNING *`;
  const { rows } = await pool.query(sql, keys.map((k) => data[k]));
  return rows[0];
}

/**
 * Build an Express router with the five CRUD routes for one entity.
 *
 * entity = { table, columns, required?, parent?: { table, key } }
 * opts   = { children?: [entity, ...] }   each child must declare `parent` pointing at this table
 *
 * Routes:  GET /  GET /:id  POST /  PUT /:id  DELETE /:id
 *          GET /:id/<child>  POST /:id/<child>       (one pair per child)
 * GET /:id embeds each child list as a JSON array; GET /?<parent.key>=N filters by parent.
 */
export function crudRouter(entity, { children = [] } = {}) {
  const { table, columns, parent } = entity;
  [table, ...columns, ...(entity.required ?? [])].forEach(ident);
  if (parent) [parent.table, parent.key].forEach(ident);
  for (const child of children) {
    if (child.parent?.table !== table) throw new Error(`${child.table} must declare parent ${table}`);
    [child.table, child.parent.key].forEach(ident);
  }

  const router = Router();

  router.param("id", (req, res, next, id) =>
    isId(id) ? next() : res.status(400).json({ error: "id must be an integer" })
  );

  const embeds = children.map(
    (c) => `COALESCE((SELECT json_agg(c ORDER BY c.id) FROM ${c.table} c WHERE c.${c.parent.key} = t.id), '[]'::json) AS ${c.table}`
  );
  const selectOne = `SELECT t.*${embeds.length ? ", " + embeds.join(", ") : ""} FROM ${table} t WHERE t.id = $1`;

  // LIST  (?limit=&offset= paginate; X-Total-Count carries the unpaginated count)
  router.get("/", wrap(async (req, res) => {
    const filter = parent && req.query[parent.key];
    if (filter != null && !isId(filter))
      return res.status(400).json({ error: `${parent.key} must be an integer id` });
    const page = pagination(req.query);
    if (page.error) return res.status(400).json({ error: page.error });
    const where = filter != null ? `WHERE ${parent.key} = $1` : "";
    const params = filter != null ? [filter] : [];
    const n = params.length;
    // Count separately so the total is right even when the requested page is empty.
    const [{ rows }, { rows: [{ count }] }] = await Promise.all([
      pool.query(`SELECT * FROM ${table} ${where} ORDER BY id LIMIT $${n + 1} OFFSET $${n + 2}`, [...params, page.limit, page.offset]),
      pool.query(`SELECT COUNT(*)::int AS count FROM ${table} ${where}`, params),
    ]);
    res.set("X-Total-Count", String(count));
    res.json(rows);
  }));

  // READ ONE (with children embedded)
  router.get("/:id", wrap(async (req, res) => {
    const { rows } = await pool.query(selectOne, [req.params.id]);
    rows.length ? res.json(rows[0]) : notFound(res, table, req.params.id);
  }));

  // CREATE
  router.post("/", wrap(async (req, res) => {
    const data = pick(entity, req.body);
    const error = validate(entity, data, { creating: true });
    if (error) return res.status(400).json({ error });
    if (parent && data[parent.key] != null && !(await exists(parent.table, data[parent.key])))
      return notFound(res, parent.table, data[parent.key]);
    res.status(201).json(await insert(entity, data));
  }));

  // UPDATE (partial: only the fields sent are changed)
  router.put("/:id", wrap(async (req, res) => {
    const data = pick(entity, req.body);
    const keys = Object.keys(data);
    if (!keys.length)
      return res.status(400).json({ error: `nothing to update; writable fields: ${writable(entity).join(", ")}` });
    const error = validate(entity, data, { creating: false });
    if (error) return res.status(400).json({ error });
    if (parent && data[parent.key] != null && !(await exists(parent.table, data[parent.key])))
      return notFound(res, parent.table, data[parent.key]);
    const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(", ");
    const { rows } = await pool.query(
      `UPDATE ${table} SET ${sets}, updated_at = NOW() WHERE id = $${keys.length + 1} RETURNING *`,
      [...keys.map((k) => data[k]), req.params.id]
    );
    rows.length ? res.json(rows[0]) : notFound(res, table, req.params.id);
  }));

  // DELETE (children go with it via ON DELETE CASCADE)
  router.delete("/:id", wrap(async (req, res) => {
    const { rowCount } = await pool.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
    rowCount ? res.status(204).end() : notFound(res, table, req.params.id);
  }));

  // NESTED: /:id/<child>
  for (const child of children) {
    const key = child.parent.key;

    router.get(`/:id/${child.table}`, wrap(async (req, res) => {
      if (!(await exists(table, req.params.id))) return notFound(res, table, req.params.id);
      const { rows } = await pool.query(`SELECT * FROM ${child.table} WHERE ${key} = $1 ORDER BY id`, [req.params.id]);
      res.json(rows);
    }));

    router.post(`/:id/${child.table}`, wrap(async (req, res) => {
      if (!(await exists(table, req.params.id))) return notFound(res, table, req.params.id);
      const data = { ...pick(child, req.body), [key]: Number(req.params.id) };
      const error = validate(child, data, { creating: true });
      if (error) return res.status(400).json({ error });
      res.status(201).json(await insert(child, data));
    }));
  }

  return router;
}

export { wrap };
