import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { pool } from "./db.js";
import { migrate } from "./migrate.js";

// Normalise API_PREFIX: "api", "/api/", "//api" all become "/api"; "" or "/" mean the root.
const rawPrefix = (process.env.API_PREFIX ?? "/api").replace(/^\/+|\/+$/g, "");
const PREFIX = rawPrefix ? `/${rawPrefix}` : "";
const ORIGIN = process.env.CORS_ORIGIN ?? "*";

const app = express();
app.disable("x-powered-by");
app.use(cors({
  origin: ORIGIN === "*" ? "*" : ORIGIN.split(",").map((s) => s.trim()),
  exposedHeaders: ["X-Total-Count"],
}));
app.use(express.json());

// Used by the Dockerfile HEALTHCHECK (and therefore by `docker compose up --wait`).
app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "db unavailable", error: err.message });
  }
});

// Auto-mount every src/entities/<name>/routes.js at <PREFIX>/<name>.
// Adding an entity is a new folder (plus a migration); nothing here changes.
const entitiesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "entities");
const entities = {};
const names = (await readdir(entitiesDir, { withFileTypes: true }))
  .filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const name of names) {
  const { default: router } = await import(`./entities/${name}/routes.js`);
  const { default: config } = await import(`./entities/${name}/config.js`);
  app.use(`${PREFIX}/${name}`, router);
  entities[name] = {
    path: `${PREFIX}/${name}`,
    table: config.table,
    columns: config.columns,
    required: config.required ?? [],
    parent: config.parent ?? null,
  };
}

// Discovery endpoint for API consumers.
app.get(PREFIX || "/", (_req, res) => res.json({ entities }));

app.use((_req, res) => res.status(404).json({ error: "route not found" }));

// Map common failures to 4xx; anything else is a 500 with details only in the log.
const PG_STATUS = { "22003": 400, "22P02": 400, "22007": 400, "22008": 400, "23502": 400, "23503": 409, "23505": 409 };
app.use((err, _req, res, _next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "invalid JSON body" });
  // body-parser and friends attach a 4xx status (413 too large, 415 bad charset, ...)
  if (Number.isInteger(err.status) && err.status >= 400 && err.status < 500)
    return res.status(err.status).json({ error: err.expose ? err.message : "bad request" });
  const status = PG_STATUS[err.code];
  if (status) return res.status(status).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: "internal error" });
});

// Apply pending migrations before accepting traffic.
try {
  await migrate();
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`API listening on http://0.0.0.0:${port}${PREFIX}  entities: ${names.join(", ")}`)
);

// Graceful shutdown on `docker compose down` (SIGTERM) or Ctrl-C (SIGINT).
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
  });
}
