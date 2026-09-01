# crud-app

A minimal **Create / Read / Update / Delete** REST API (Node 22 + Express + PostgreSQL 16)
packaged with **Docker Compose**. The config files are kept as small as possible; this
README carries the explanation.

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
│   ├── server.js            # Express routes (the CRUD endpoints)
│   └── db.js                # Postgres connection pool
├── db/
│   └── init.sql             # schema + seed rows, runs once on first DB start
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
curl localhost:3000/items
curl -X POST localhost:3000/items -H 'content-type: application/json' -d '{"name":"milk"}'
curl -X PUT  localhost:3000/items/1 -H 'content-type: application/json' -d '{"description":"2 litres"}'
curl -X DELETE localhost:3000/items/1
```

Stop everything:

```bash
docker compose down
```

## API

| Method | Path | Body | Result |
|---|---|---|---|
| GET | `/health` | | `{"status":"ok"}` when the DB answers, 503 otherwise |
| POST | `/items` | `{"name","description?"}` | 201 with the new row |
| GET | `/items` | | all rows |
| GET | `/items/:id` | | one row or 404 |
| PUT | `/items/:id` | `{"name?","description?"}` | updated row or 404 |
| DELETE | `/items/:id` | | 204 or 404 |

Every query is parameterised (`$1`, `$2`) so user input never reaches SQL as text.
`src/server.js` also handles `SIGTERM`: it stops accepting connections, waits for
in-flight requests, closes the DB pool, then exits, so `docker compose down` is clean.

## Configuration (`.env`)

Compose reads `.env` from the project directory automatically. `.env` is git-ignored
and docker-ignored; commit `.env.example` as documentation.

| Variable | Used by | Meaning |
|---|---|---|
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | db, api | The official Postgres image creates this role and database on first start. The API uses the same values to connect. |
| `API_PORT` | api | Host port that maps to the API's port 3000. Default 3000. Published on **all interfaces** (IPv4 and IPv6) in both dev and production; see *Exposure*. |
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
* `pgdata:/var/lib/postgresql/data` is the named volume holding the database.
* `./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro` is a read-only bind mount. The
  image runs any `.sql` in that folder exactly once, when the data directory is empty.
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

**Live reload.** `./src` is bind-mounted read-only over the copy baked into the image,
and the command becomes `node --watch`, so editing a file on the host restarts the
server in the container. This is a dev convenience only: the production image already
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
| 2. Commit | `git add` picks up code, `Dockerfile`, both Compose files, `db/init.sql`, `.env.example`. | `.gitignore` keeps `.env` out; the data directory is outside the repo |
| 3. Push | GitHub Actions builds the image and smoke-tests the whole stack with a throw-away database on the runner. | CI writes its own `.env` from `.env.example` and its own temporary `PGDATA_DIR` |
| 4. Deploy | On the server: clone, create a **new** `.env` with a real password, create `PGDATA_DIR`, run `docker compose -f compose.yaml up -d --build`. No override, so no GUIs and no bind mounts. | Server-side `.env` and `PGDATA_DIR`, created by hand, never in git |
| 5. Update | Pull, rebuild, `up -d`. The image is replaced; the database volume is untouched. | `PGDATA_DIR` persists across image upgrades |

What stays hidden, and where:

| File | In git? | In the image? | Why |
|---|---|---|---|
| `.env` | No (`.gitignore`) | No (`.dockerignore`) | Holds the database password. Each environment has its own. |
| `PGDATA_DIR` contents | No (outside the repo) | No | The actual database files. Data never travels through git or images; move it with `pg_dump` / `pg_restore`. |
| `nocodb_data` volume | No | No | NocoDB accounts and views, dev only. |
| `db/init.sql` | **Yes** | No (used by the `db` container via bind mount, not built into the API image) | Schema and seed rows. It is public in the repo, so keep real data out of it. |
| `.env.example` | **Yes** | No | Placeholder values only. |
| `compose*.yaml`, `Dockerfile` | **Yes** | No | Describe the stack; contain no secrets because everything sensitive is `${VAR}` from `.env`. |

Two consequences worth remembering:

* A fresh production server starts with an empty database seeded only by `db/init.sql`.
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
image, starts the stack with `--wait` (blocks until healthchecks pass), exercises every
CRUD endpoint with `curl`, prints logs on failure and tears down.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `set PGDATA_DIR in .env` error | `.env` is missing or lacks `PGDATA_DIR`. Copy `.env.example`. |
| `failed to mount local volume ... no such file or directory` | `PGDATA_DIR` does not exist on the host. `mkdir -p` it. |
| `cannot assign requested address` | `GUI_BIND_ADDR` is not an IP of this machine any more (DHCP changed it). Fix `.env` or reserve the IP. |
| Changed `PGDATA_DIR` but data still goes to the old place | Compose keeps existing volumes. `docker compose -f compose.yaml down -v`, then `up`. |
| API container `unhealthy`, `wget: can't connect` | Healthcheck must use `127.0.0.1`, not `localhost`, on Alpine. |
| `init.sql` changes have no effect | It only runs on an empty data directory. Apply changes with Adminer or `psql`, or wipe the directory. |
