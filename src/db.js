import pg from "pg";

// A Pool keeps a few open connections and hands them out per query.
// Every value comes from the environment so the same image works in
// dev, CI and prod. Compose injects these from the .env file.
export const pool = new pg.Pool({
  host: process.env.DB_HOST ?? "db",       // "db" = the service name in compose.yaml
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
