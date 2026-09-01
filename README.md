# crud-app

A minimal **Create / Read / Update / Delete** REST API (Node 22 + Express + PostgreSQL 16)
packaged with **Docker Compose**. Every file is annotated so the project doubles as a
reference for how a typical containerised web app fits together.

```
crud-app/
├── Dockerfile               # how to build the API image (multi-stage)
├── compose.yaml             # the stack: api + db, network, volume
├── compose.override.yaml    # dev-only extras (live reload, Adminer, NocoDB); auto-merged
├── .env.example             # template for secrets/config -> copy to .env
├── .dockerignore            # what NOT to send into the image build
├── .gitignore
├── package.json / package-lock.json
├── src/
│   ├── server.js            # Express routes (the CRUD endpoints)
│   └── db.js                # Postgres connection pool
├── db/
│   └── init.sql             # schema + seed rows, runs once on first DB start
└── .github/workflows/ci.yaml# GitHub Actions: build + smoke test the stack
```

## Quick start

```bash
cp .env.example .env        # then edit POSTGRES_PASSWORD
docker compose up --build   # dev mode (live reload via compose.override.yaml)
```

Production-style (ignores the override file, runs detached):

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

Stop everything (add `-v` to also delete the database volume):

```bash
docker compose down
```

## The Dockerfile, line by line

| Instruction | Why it is there |
|---|---|
| `# syntax=docker/dockerfile:1` | Opt in to the current BuildKit frontend and its features. |
| `FROM node:22-alpine AS deps` | Start from a small, pinned base. `AS deps` names this stage so a later stage can copy from it. |
| `WORKDIR /app` | Creates and `cd`s into `/app`; every later relative path is inside it. |
| `COPY package.json package-lock.json ./` | Copy only the dependency manifests first so the next layer is cached until they change. |
| `RUN npm ci --omit=dev` | Reproducible install from the lockfile, without dev tooling. |
| `FROM node:22-alpine AS runtime` | A **second, fresh** stage: the final image contains only what we copy in here. |
| `ENV NODE_ENV=production` | Express and many libs switch off debug behaviour when this is set. |
| `COPY --from=deps /app/node_modules ./node_modules` | Pull the installed packages across from stage 1 and nothing else. |
| `COPY package.json ./` / `COPY src ./src` | Bring in the app. `.dockerignore` filters what is eligible. |
| `USER node` | Drop root privileges. If the app is compromised the attacker is an unprivileged user. |
| `EXPOSE 3000` | Metadata only. The real host mapping is `ports:` in `compose.yaml`. |
| `HEALTHCHECK ... wget http://localhost:3000/health` | Lets Docker/Compose know whether the process is actually serving requests. |
| `CMD ["node", "src/server.js"]` | Exec form: node is PID 1 and receives `SIGTERM` for a clean shutdown. |

Why **multi-stage**? Stage 1 may leave behind npm caches, build tools and temp files.
Stage 2 starts clean and copies in only the results, giving a smaller image with a
smaller attack surface.

## compose.yaml, section by section

* **`name:`** – project name used to prefix containers, networks and volumes (`crud-app-api-1`, `crud-app_pgdata`).
* **`services.api`**
  * `build:` – build from the local Dockerfile instead of pulling an image.
  * `ports: "${API_PORT:-3000}:3000"` – publish container port 3000 on the host. `${VAR:-default}` reads `.env` with a fallback.
  * `environment:` – configuration is injected at run time, so the same image works anywhere. `DB_HOST: db` works because Compose gives every service a DNS name on the shared network.
  * `depends_on: db: condition: service_healthy` – start order **and** readiness: the API is not started until Postgres passes its healthcheck.
  * `restart: unless-stopped` – auto-restart on crash or reboot, but respect a manual `compose stop`.
* **`services.db`**
  * `image: postgres:16-alpine` – official image, pinned major version.
  * `POSTGRES_*` – variables the official image uses to create the role and database on first boot.
  * `volumes: pgdata:/var/lib/postgresql/data` – a **named volume** so data outlives the container. See *Where the data lives* below.
  * `volumes: ./db/init.sql:/docker-entrypoint-initdb.d/init.sql:ro` – a **bind mount**; the image runs any `.sql` in that folder exactly once, when the data directory is empty.
  * `healthcheck: pg_isready` – what `service_healthy` above waits for.
  * No `ports:` – the DB is unreachable from outside the Docker network. Uncomment the block if you want to attach a GUI client.
* **`volumes:` / `networks:`** – declare the named volume and the private bridge network the services reference.

## Where the data lives

The `pgdata` volume is a named volume, but `driver_opts` pins it to a host directory
(`PGDATA_DIR` in `.env`, default `/home/mike/docker/data/crud-app/pgdata`) instead of
Docker's internal `/var/lib/docker/volumes` location. You get the best of both:

* Docker still creates the volume and fixes ownership for the Postgres user (uid 70).
* The files sit in a path you control, so you can back them up, snapshot them, or move
  them to another machine with ordinary host tools.

The directory **must exist** before the first `docker compose up` (Docker will not
create it for a `type: none` bind). Keep it outside the git repo. Note that
`docker compose down -v` only removes Docker's *record* of the volume; the files on disk
stay put, so wipe the directory yourself if you want a truly fresh database.

For a consistent backup, dump rather than copy raw files:

```bash
docker compose exec db pg_dump -U app app | gzip > backup-$(date +%F).sql.gz
```

## compose.override.yaml (development only)

Compose merges `compose.override.yaml` on top of `compose.yaml` automatically. Here it
bind-mounts `./src` into the container and swaps the command for `node --watch`, so
editing a file on the host restarts the server inside the container. It also adds the
database GUIs described below. Pass `-f compose.yaml` explicitly to skip it.

Note that the bind mount is a dev convenience only. The production image already
contains a copy of `src` because the Dockerfile runs `COPY src ./src` at build time,
so production never reads source from the host or from git at run time.

## Database GUIs (development only)

`compose.override.yaml` also starts two tools for looking at and editing the data.
They are absent when you deploy with `-f compose.yaml`.

Which host address they listen on is controlled by `GUI_BIND_ADDR` in `.env`:

* `127.0.0.1` (the default in `.env.example`) – only a browser on this machine can reach them.
* your LAN IP, e.g. `192.168.1.50` – any device on the local network can reach them.
  Fine on a trusted home network; do not do this on shared Wi-Fi.
* a VPN address (Tailscale, WireGuard) – reachable from your devices anywhere, and nothing else.

Docker publishes ports with its own iptables rules that bypass host firewalls such as
ufw, so the bind address is the thing that actually limits exposure. If the machine
gets its address from DHCP, reserve it in your router so the IP does not change; a
stale address makes the containers fail to start with "cannot assign requested address".

| Tool | URL | What it is good for |
|---|---|---|
| Adminer | http://GUI_BIND_ADDR:8080 | Quick SQL console and table browser. Log in with System **PostgreSQL**, Server `db`, and the user/password/database from `.env`. |
| NocoDB | http://GUI_BIND_ADDR:8081 | Airtable-style spreadsheet, forms, kanban and gallery views over the same tables. |

NocoDB first-time setup: create the admin account, then **New base → Connect external
data → PostgreSQL** with host `db`, port `5432`, and the user, password and database
from `.env`. NocoDB stores its own metadata (accounts, bases, views) in the
`nocodb_data` volume, separate from the application database.

If you would rather start these only on demand, add `profiles: [tools]` to each
service and run `docker compose --profile tools up`.

## .env and secrets

`compose.yaml` contains no passwords; they live in `.env`, which is git-ignored and
docker-ignored. Commit `.env.example` as documentation. For real deployments consider
Docker secrets or your platform's secret store instead of a plain file.

## GitHub Actions

`.github/workflows/ci.yaml` builds the image, brings the whole stack up with
`--wait` (blocks until healthchecks pass), exercises every CRUD endpoint with `curl`,
prints logs on failure and tears down.

## Push to GitHub

```bash
git init -b main
git add .
git commit -m "Initial Docker Compose CRUD app"
gh repo create crud-app --public --source=. --push
```
