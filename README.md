# crud-app

A minimal **Create / Read / Update / Delete** REST API (Node 22 + Express + PostgreSQL 16)
packaged with **Docker Compose**, built to be called from a separate web app. Entities
are declared as small config objects, a factory builds their routes, and the server
auto-mounts every entity folder, so adding one is a folder and a migration. The config
files are kept as small as possible; this README carries the explanation.

```
crud-app/
├── Dockerfile               # builds the API image (multi-stage)
├── compose.yaml             # production stack: api + db
├── compose.override.yaml    # dev-only additions: live reload, Adminer, NocoDB (auto-merged)
├── .env.example             # template for all settings -> copy to .env
├── .dockerignore            # what never enters the image build
├── .gitignore
├── package.json / package-lock.json
├── src/
│   ├── server.js            # app setup, CORS, auto-mounts src/entities/*, migrations, shutdown
│   ├── db.js                # Postgres connection pool
│   ├── migrate.js           # migration runner (also `npm run migrate`)
│   ├── lib/crud.js          # the CRUD router factory
│   └── entities/
│       ├── tasks/           # parent entity: config.js + routes.js (adds POST /tasks/:id/done)
│       └── items/           # child entity: config.js + routes.js
├── db/migrations/           # numbered .sql files applied in order at startup
├── scripts/smoke.sh         # end-to-end API check, run by CI and `npm run smoke`
├── devproxy/
│   └── Caddyfile            # optional authenticated gateway for the dev GUIs (disabled)
└── .github/workflows/ci.yaml# GitHub Actions: build + smoke test the stack
```

## Quick start

```bash
cp .env.example .env                          # then edit POSTGRES_PASSWORD and PGDATA_DIR
mkdir -p "$(grep ^PGDATA_DIR .env | cut -d= -f2)"
docker compose up --build                     # dev mode: live reload + GUIs
```

Production-style, detached, without the dev additions:

```bash
docker compose -f compose.yaml up -d --build
```

Try it:

```bash
curl localhost:3000/api                    # discovery: every entity and its path
task=$(curl -s -X POST localhost:3000/api/tasks -H 'content-type: application/json' -d '{"title":"Weekly shop"}' | jq -r .id)
item=$(curl -s -X POST localhost:3000/api/tasks/$task/items -H 'content-type: application/json' -d '{"name":"milk"}' | jq -r .id)
curl localhost:3000/api/tasks/$task        # the task with its items embedded
curl -X PUT  localhost:3000/api/items/$item -H 'content-type: application/json' -d '{"description":"2 litres"}'
curl -X DELETE localhost:3000/api/tasks/$task  # cascades to its items
```

Ids are captured from the responses because a fresh database already holds two seed
items (ids 1 and 2).

Or run the full end-to-end check against the running stack (needs `curl` and `jq`):

```bash
npm run smoke
```

Stop everything:

```bash
docker compose down
```

## API

Every entity route lives under `API_PREFIX` (default `/api`); `/health` stays at the root.
Two entities so far. A **task** (or reminder) is the parent; **items** are its children.
An item's `task_id` may be null, so loose items are allowed.

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/health` | | `{"status":"ok"}` when the DB answers, 503 otherwise |
| GET | `/api` | | discovery: `{"entities": {name: {path, table, columns, required, parent}}}` |
| GET | `/api/tasks` | | all tasks (paginated, see below) |
| POST | `/api/tasks` | `{"title","due_at?","done?"}` | 201 with the new task |
| GET | `/api/tasks/:id` | | the task **with `items: [...]` embedded**, or 404 |
| PUT | `/api/tasks/:id` | any writable fields | updated task or 404 |
| DELETE | `/api/tasks/:id` | | 204; **its items are deleted too** |
| POST | `/api/tasks/:id/done` | | marks the task done (entity-specific route) |
| GET | `/api/tasks/:id/items` | | the task's items, 404 if the task does not exist |
| POST | `/api/tasks/:id/items` | `{"name","description?"}` | 201, `task_id` set from the URL |
| GET | `/api/items` | | all items (paginated); `?task_id=N` filters to one task |
| POST | `/api/items` | `{"name","description?","task_id?"}` | 201; 404 if `task_id` names no task |
| GET | `/api/items/:id` | | one item or 404 |
| PUT | `/api/items/:id` | any writable fields | partial update; set `task_id` to move or `null` to detach |
| DELETE | `/api/items/:id` | | 204 or 404 |

Rules that apply everywhere:

* List routes accept `?limit=` (default 100, max 500) and `?offset=` (default 0) and
  return the unpaginated total in an `X-Total-Count` response header.
* `:id`, `limit`, `offset` and parent ids must be integers up to 2,147,483,647 (Postgres
  `int4`), otherwise 400.
* JSON bodies are limited to 100 KB (413 above that).
* Fields not listed in the entity's `columns` are ignored; `required` fields must be
  present on create and non-empty on update.
* Bad values (a non-date in `due_at`, a non-boolean in `done`) come back as 400 with
  the Postgres message. Foreign-key and uniqueness conflicts are 409. Invalid JSON is 400.
* Every value is a query parameter (`$1`, `$2`); only identifiers from the entity config
  are ever interpolated into SQL, and they are checked against `[a-z_][a-z0-9_]*`.

## Entities and the CRUD factory

Each entity lives in `src/entities/<name>/` with two files:

* `config.js` declares the table and what clients may write:

  ```js
  export default {
    table: "items",
    columns: ["name", "description"],   // writable columns
    required: ["name"],
    parent: { table: "tasks", key: "task_id" },   // omit for a top-level entity
  };
  ```

* `routes.js` turns that into a router, optionally with children and custom routes:

  ```js
  const router = crudRouter(tasks, { children: [items] });
  router.post("/:id/done", wrap(async (req, res) => { ... }));
  export default router;
  ```

`src/lib/crud.js` generates the five standard routes from the config. Passing `children`
adds `GET/POST /:id/<child table>` and embeds each child list in `GET /:id` with a single
`json_agg` query. `wrap` forwards rejected promises to the error handler, which Express 4
does not do on its own.

`src/server.js` scans `src/entities/` at startup and mounts each folder's `routes.js` at
`API_PREFIX/<folder name>`, so the folder name is the URL path. It also reads each
`config.js` to build the discovery response at `GET /api`.

To add an entity, say `notes` under `tasks`:

1. `db/migrations/003_notes.sql` creating the table with `task_id INTEGER REFERENCES
   tasks(id) ON DELETE CASCADE` and an index on it.
2. `src/entities/notes/config.js` with `parent: { table: "tasks", key: "task_id" }`.
3. `src/entities/notes/routes.js` exporting `crudRouter(notes)`.
4. Optionally add `notes` to the `children` list in `src/entities/tasks/routes.js` to get
   `/api/tasks/:id/notes` and embedding. Restart the API; nothing in `server.js` changes.

Keep entity-specific SQL out of the factory: put it in a `repo.js` next to the config and
call it from a custom route, as `tasks/routes.js` does inline for `/done`.

## Consuming the API from a separate web app

The API is designed to sit behind a front end served from somewhere else (a Vite or
Next dev server, a static host, a phone app).

* **CORS.** `CORS_ORIGIN` controls which browser origins may call the API. `*` (the
  default) is convenient for development. In production set it to the web app's exact
  origin, or a comma-separated list. CORS is not authentication: it only tells browsers
  which sites may read responses. The `X-Total-Count` header is exposed to browsers.
* **Prefix.** Everything lives under `API_PREFIX` (`/api`), which makes it easy to put
  the web app and the API behind one reverse proxy: `/` to the front end, `/api` here.
  Doing that also removes the need for CORS at all. Caddy can do it in three lines.
* **Discovery.** `GET /api` returns every entity with its path, writable columns,
  required fields and parent relation. A front end can build forms from it.
* **Errors.** Every error is `{"error": "message"}` with a meaningful status: 400 for
  bad input, 404 for a missing row or parent, 409 for constraint conflicts, 500 only
  for genuine failures.
* **Pagination.** `?limit=&offset=` plus `X-Total-Count`, so a list view can show page
  N of M.

Minimal browser example:

```js
const API = "http://192.168.1.50:3000/api";
const res = await fetch(`${API}/tasks?limit=20`);
const total = res.headers.get("X-Total-Count");
const tasks = await res.json();

await fetch(`${API}/tasks/${tasks[0].id}/items`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: "milk" }),
});
```

There is no authentication yet. Add it as one Express middleware in `server.js` before
the entity mounts (an API key header, or a JWT check), and it protects every entity,
present and future.

## Migrations

`db/migrations/*.sql` are applied in filename order (zero-pad the number: `001_`, `002_`)
by `src/migrate.js`, which the server runs before it starts listening. You can also run it
by hand:

```bash
docker compose exec api npm run migrate
```

How it works:

* A `schema_migrations` table records each applied filename, so a file runs exactly once.
* Each file runs inside its own transaction and is recorded in the same transaction, so a
  failing migration leaves nothing half-applied and the server refuses to start.
* A Postgres advisory lock serialises runners, so several API replicas starting at once
  do not race.
* Files are read from `db/migrations` inside the image (copied by the Dockerfile) or, in
  dev, from the bind-mounted host folder. `node --watch` does not watch `.sql` files, so
  restart the container after adding one: `docker compose restart api`.

Migrations replace the old `init.sql` approach, which only ran on an empty data
directory and could never change an existing database. `001_items.sql` is written to be
safe on databases created by that older `init.sql`: it uses `CREATE TABLE IF NOT EXISTS`
and seeds only an empty table.

Migrations are forward-only. To undo one, write the next migration.

## Configuration (`.env`)

Compose reads `.env` from the project directory automatically. `.env` is git-ignored
and docker-ignored; commit `.env.example` as documentation.

| Variable | Used by | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | db, api | The official Postgres image creates this role and database on first start. The API uses the same values to connect. |
| `API_PORT` | api | Host port that maps to the API's port 3000. Default 3000. Published on **all interfaces** (IPv4 and IPv6) in both dev and production; see *Exposure*. |
| `API_PREFIX` | api | URL prefix for entity routes. Default `/api`. Blank (or `/`) mounts them at `/`; leading and trailing slashes are normalised, so `api` and `/api/` both work. |
| `CORS_ORIGIN` | api | Browser origins allowed to call the API. `*` (default) or a comma-separated list. |
| `PGDATA_DIR` | db volume | Absolute host path holding the Postgres data files. **Must exist** before the first start. Required; Compose refuses to start without it. |
| `GUI_BIND_ADDR` | dev GUIs | Host address Adminer and NocoDB listen on. `127.0.0.1` = this machine only. A LAN or VPN IP lets other devices in. |
| `GUI_AUTH_USER` / `GUI_AUTH_HASH` | devproxy | Only needed if the optional Caddy gateway is enabled. |

## The Dockerfile

| Instruction | Why |
|---|---|
| `# syntax=docker/dockerfile:1` | Use the current BuildKit frontend. |
| `FROM node:22-alpine AS deps` | Small, pinned base image. `AS deps` names the stage so it can be copied from later. |
| `WORKDIR /app` | Creates `/app` and makes every later path relative to it. |
| `COPY package.json package-lock.json ./` | Manifests first. Docker caches this layer, so the install below is skipped when only source changes. |
| `RUN npm ci --omit=dev` | Reproducible install from the lockfile, without dev tooling. |
| `FROM node:22-alpine AS runtime` | A second, fresh stage. The shipped image contains only what is copied in here, not npm caches or build leftovers. |
| `ENV NODE_ENV=production` | Express and many libraries switch off debug behaviour. |
| `COPY --from=deps /app/node_modules ./node_modules` | Bring the installed packages across from stage 1. |
| `COPY package.json ./` / `COPY src ./src` | The application. `.dockerignore` filters what is eligible. |
| `COPY db/migrations ./db/migrations` | The migration runner reads these from inside the image, so a production server needs no source checkout. |
| `USER node` | Drop root. The official image ships an unprivileged `node` user. |
| `EXPOSE 3000` | Documentation only. The host mapping is `ports:` in `compose.yaml`. |
| `HEALTHCHECK ... wget http://127.0.0.1:3000/health` | Docker marks the container healthy only when the API answers and can reach the DB. `127.0.0.1` rather than `localhost` because Alpine resolves `localhost` to `::1` first and node listens on IPv4 only. |
| `CMD ["node", "src/server.js"]` | Exec form: node is PID 1 and receives `SIGTERM` directly. |

Why two stages: `npm ci` in stage 1 does more than fill `node_modules`. It also writes
npm's download cache and logs to `/root/.npm`, and image layers are additive, so even an
`rm -rf` in a later `RUN` would not remove them from a single-stage image. Stage 2 starts
from a clean base and copies in only `node_modules`, so the cache, the logs and anything
else stage 1 produced never enter the final image. Fewer files means a smaller image and
less for an attacker to work with.

## compose.yaml

The production stack. No `version:` key is needed with Compose v2.

**`name: crud-app`** prefixes containers, networks and volumes (`crud-app-api-1`,
`crud-app_pgdata`).

**`api`**

* `build: .` builds from the local Dockerfile. Compose names the image `crud-app-api`.
* `ports: "${API_PORT:-3000}:3000"` publishes the API on every interface of the host.
  `${VAR:-default}` reads `.env` with a fallback.
* `environment:` injects configuration at run time, so one image works everywhere.
  `DB_HOST: db` works because Compose gives every service a DNS name on the shared
  network.
* `depends_on: db: condition: service_healthy` waits for Postgres to pass its
  healthcheck, not merely to exist.
* `restart: unless-stopped` restarts after crashes and reboots but respects a manual
  `compose stop`.

**`db`**

* `image: postgres:16-alpine`, official image, pinned major version.
* `POSTGRES_*` create the role and database on first boot.
* `pgdata:/var/lib/postgresql/data` is the named volume holding the database. The schema
  is created by the API's migration runner, not by the database image.
* `healthcheck: pg_isready` is what `service_healthy` waits for.
* No `ports:`. The database is reachable only from containers on `backend`, never from
  the host or the network. Add `"127.0.0.1:5432:5432"` if you want a local GUI client.

**`volumes.pgdata`** is a named volume pinned to a host directory, see *Where the data
lives*. The `local` driver is the default, so it is not spelled out. **`networks.backend`** is a private bridge network; containers on it reach each
other by service name.

## Where the data lives

`pgdata` is declared with `driver_opts` that bind it to `PGDATA_DIR` instead of Docker's
internal `/var/lib/docker/volumes` location. You get both:

* Docker still creates the volume and fixes ownership for the Postgres user (uid 70).
* The files sit in a path you control, so you can back them up, snapshot them, or move
  them to another machine with ordinary tools.

Things to know:

* The directory **must exist** first. Docker will not create it for a `type: none` bind.
* Keep it outside the git repo and off synced folders (Dropbox, OneDrive) and network
  shares without proper locking (some NFS/SMB). Postgres can corrupt data there.
* Compose **never recreates an existing volume** when its options change. After
  changing `PGDATA_DIR`, run `docker compose -f compose.yaml down -v` and move the old
  files yourself.
* For `pgdata`, `down -v` removes only Docker's *record* of the volume; the files on
  disk stay. Wipe the directory by hand for a truly fresh database. Note that a plain
  `docker compose down -v` (override merged) also deletes the ordinary `nocodb_data`
  volume, and with it NocoDB's accounts and views. Use `-f compose.yaml` to leave it alone.

For a consistent backup, dump rather than copy raw files:

```bash
docker compose exec db pg_dump -U app app | gzip > backup-$(date +%F).sql.gz
```

## Development override

Compose merges `compose.override.yaml` on top of `compose.yaml` automatically for plain
`docker compose up`. Pass `-f compose.yaml` explicitly to skip it. It adds:

**Live reload.** `./src` and `./db/migrations` are bind-mounted read-only over the copies
baked into the image, and the command becomes `node --watch`, so editing a source file on
the host restarts the server in the container. This is a dev convenience only: the production image already
contains `src` from the Dockerfile's `COPY`, and never reads source from the host or
from git at run time.

**Adminer** at `http://GUI_BIND_ADDR:8080`. Quick SQL console and table browser. Log in
with System *PostgreSQL*, Server `db`, and the user, password and database from `.env`.

**NocoDB** at `http://GUI_BIND_ADDR:8081`. Airtable-style spreadsheet, forms, kanban and
gallery views over the same tables. First run: create the admin account, then
*New base → Connect external data → PostgreSQL* with host `db`, port `5432`, and the
credentials from `.env`. NocoDB keeps its own metadata in the `nocodb_data` volume, so it
never writes into the `app` database. Its image is on the floating `latest` tag; pin a
version once you have one you like.

### Exposure

The API itself listens on every interface in both modes, so anything that can reach
the host on `API_PORT` can create, edit and delete items; it has no authentication of
its own. That is expected for the application, and in production it belongs behind a
reverse proxy or firewall rule. To keep it local in dev, add to the override:

```yaml
  api:
    ports: !override
      - "127.0.0.1:${API_PORT:-3000}:3000"
```

Both GUIs have full read/write access to the database. Adminer has no login of its own
beyond the DB password, and NocoDB's first-run signup is open to whoever arrives first.
`GUI_BIND_ADDR` is therefore the security control for them:

* `127.0.0.1` (the default in `.env.example`): only a browser on this machine. From
  another device, use an SSH tunnel and browse `localhost:8081` there:

  ```bash
  ssh -N -L 8080:127.0.0.1:8080 -L 8081:127.0.0.1:8081 user@server
  ```

* A LAN IP such as `192.168.1.50`: anyone on the local network. Acceptable on a trusted
  home network, not on shared Wi-Fi. If the machine gets its IP from DHCP, reserve it in
  the router: a stale address makes the containers fail with "cannot assign requested
  address".
* A VPN address (Tailscale, WireGuard): only your own devices, from anywhere.

Docker publishes ports through its own iptables rules, which are evaluated before host
firewalls such as ufw. A `ufw deny 8081` does **not** block a published container port.
The bind address is what actually limits exposure. If you want ufw to cover containers,
add rules to Docker's `DOCKER-USER` chain or use the `ufw-docker` helper.

## Optional: Caddy gateway

`compose.override.yaml` contains a commented-out `devproxy` service and
`devproxy/Caddyfile`. Enabled, it becomes the only published dev service: it asks for a
username and password, then forwards to Adminer and NocoDB over a private `tools`
network, and the two GUIs lose their `ports:` entirely so there is no way around it.
The gateway is deliberately not on `backend`, so it cannot reach the database.

To enable it:

1. In `compose.override.yaml`, uncomment the `devproxy` service and the `tools` network.
2. Remove the `ports:` block from `adminer` and `nocodb` and add `tools` to their
   `networks:` list.
3. In `.env`, set `GUI_AUTH_USER` and `GUI_AUTH_HASH`. Generate the hash with

   ```bash
   docker run --rm caddy:2-alpine caddy hash-password --plaintext 'your-password'
   ```

   and keep the single quotes around it in `.env`, because bcrypt hashes contain `$`.
4. `docker compose up -d --remove-orphans`.

Caddy is Apache-2.0 licensed with no paid tier. Everything it can do here is free: basic
auth (built in, what the Caddyfile uses), automatic HTTPS from Let's Encrypt for a real
domain, a self-signed local CA via `tls internal` for LAN-only hosts, host-based routing
so every tool shares port 443, `forward_auth` to a free SSO such as Authelia for
two-factor, `remote_ip` matchers to allow only a subnet, load balancing across scaled
`api` replicas, compression, JSON access logs and Prometheus metrics. Only a domain name
would cost anything.

## From development to production

The same files serve both; what changes is which of them are in play.

| Step | What happens | DB-related files involved |
|---|---|---|
| 1. Develop | `docker compose up --build` merges the override: live reload, Adminer, NocoDB. Postgres data lands in `PGDATA_DIR` on your machine. | `.env` (your local password), `PGDATA_DIR` (your local data), `nocodb_data` volume |
| 2. Commit | `git add` picks up code, `Dockerfile`, both Compose files, `db/migrations/`, `.env.example`. | `.gitignore` keeps `.env` out; the data directory is outside the repo |
| 3. Push | GitHub Actions builds the image and smoke-tests the whole stack with a throw-away database on the runner. | CI writes its own `.env` from `.env.example` and its own temporary `PGDATA_DIR` |
| 4. Deploy | On the server: clone, create a **new** `.env` with a real password, create `PGDATA_DIR`, run `docker compose -f compose.yaml up -d --build`. No override, so no GUIs and no bind mounts. | Server-side `.env` and `PGDATA_DIR`, created by hand, never in git |
| 5. Update | Pull, rebuild, `up -d`. The image is replaced; the database volume is untouched, and any new migrations run when the new API starts. | `PGDATA_DIR` persists across image upgrades |

What stays hidden, and where:

| File | In git? | In the image? | Why |
|---|---|---|---|
| `.env` | No (`.gitignore`) | No (`.dockerignore`) | Holds the database password. Each environment has its own. |
| `PGDATA_DIR` contents | No (outside the repo) | No | The actual database files. Data never travels through git or images; move it with `pg_dump` / `pg_restore`. |
| `nocodb_data` volume | No | No | NocoDB accounts and views, dev only. |
| `db/migrations/*.sql` | **Yes** | **Yes** (the API image applies them) | Schema and seed rows. Public in the repo, so keep real data out of them. |
| `.env.example` | **Yes** | No | Placeholder values only. |
| `compose*.yaml`, `Dockerfile` | **Yes** | No | Describe the stack; contain no secrets because everything sensitive is `${VAR}` from `.env`. |

Two consequences worth remembering:

* A fresh production server starts with an empty database; the migrations create the
  schema and the two seed rows.
  To carry data over from dev, dump it there and restore it on the server:

  ```bash
  docker compose exec db pg_dump -U app app > dump.sql             # on dev
  docker compose exec -T db psql -U app app < dump.sql             # on the server
  ```

* Editing code on the server does nothing. The container runs the copy baked into the
  image at build time, so a change means rebuild and restart. To skip building on the
  server entirely, have CI push the image to a registry (GitHub Container Registry) and
  point `image:` at that tag.

For real deployments prefer Docker secrets or your platform's secret store to a plain
`.env` file.

## GitHub Actions

`.github/workflows/ci.yaml` runs on every push to `main` and on every pull request. It copies
`.env.example` to `.env`, points `PGDATA_DIR` at a runner-local directory, builds the
image, starts the stack with `--wait` (blocks until healthchecks pass), runs
`scripts/smoke.sh` against it, prints logs on failure and tears down. The smoke script
covers every route in the API table, including discovery, CORS headers, pagination,
validation errors, the nested routes, the embedded children and the cascade delete.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `set PGDATA_DIR in .env` error | `.env` is missing or lacks `PGDATA_DIR`. Copy `.env.example`. |
| `failed to mount local volume ... no such file or directory` | `PGDATA_DIR` does not exist on the host. `mkdir -p` it. On **Docker Desktop** the same error can appear for a directory created seconds earlier, because the Desktop VM has not noticed it yet; paths outside the shared folders (such as `/tmp`) can never be used. Wait a moment or restart Docker Desktop. |
| `cannot assign requested address` | `GUI_BIND_ADDR` is not an IP of this machine any more (DHCP changed it). Fix `.env` or reserve the IP. |
| Changed `PGDATA_DIR` but data still goes to the old place | Compose keeps existing volumes. `docker compose -f compose.yaml down -v`, then `up`. |
| API container `unhealthy`, `wget: can't connect` | Healthcheck must use `127.0.0.1`, not `localhost`, on Alpine. |
| API exits with `migration 00N_... failed` | The SQL in that file errored; nothing from it was applied. Fix the file and restart. Never edit an already-applied migration; add a new one. |
| Added a migration but nothing happened | `node --watch` ignores `.sql` files. `docker compose restart api`. |
