# OpenBrain database migrations

Use `python migrate.py` with Python 3 and `psycopg[binary]` 3.2. Supply connection
settings through libpq's `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, and a protected
password source (`PGPASSWORD`, `~/.pgpass`, or a service file). The database must
already have the `vector` extension.

The runner applies numbered files in order, records each filename in
`public.schema_migrations`, and skips recorded versions. A session advisory
lock serializes runners. Each file and its version record commit together;
an error rolls both back. Existing outer `BEGIN`/`COMMIT` wrappers are removed
so the runner owns the transaction. Migration files must not contain other
top-level transaction-control statements. Applied files are immutable: add a new
numbered file instead of editing one.

`--through 0002` stops after version 0002. Gaps in the numbering are fine.

## Adopting an existing database

The runner refuses a database that already has `brain_entries` but no
`schema_migrations` table, rather than guessing what was applied. If you applied
`0001_openbrain.sql` by hand from an earlier version of this repo, check which
files are really in place, then record them once before running:

```sql
create table public.schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);
insert into public.schema_migrations(version) values ('0001_openbrain.sql');
```

Only record a file you have confirmed is applied.

## Tests

To run integration tests, point the PG variables at a disposable PostgreSQL
server with pgvector available, set `MIGRATION_TEST_DISPOSABLE=yes`, then run
`python test_migrate.py`. Tests create and remove only uniquely named fixture
databases. Never point these tests at a database you care about.

## Notes

- `0001` creates an optional append-only `openbrain_app` role (INSERT + SELECT).
  `supersede_brain_entry()` from `0005` needs UPDATE, so run supersession as the
  database owner.
- `0006` grants `rsi` function execution to whichever of `openbrain`,
  `openbrain_app`, `openbrain_mcp_ro`, `openbrain_mcp_rw` exist. Edit that list if
  your MCP credentials connect as another role.
- `0007` is idempotent and safe to apply where a `reports` table already exists.
- `0008` needs PostgreSQL 15 or later (`regexp_count`). It grants
  `rsi.scan_defects()` execution to `openbrain` if that role exists; edit the list if
  your scheduler connects as another role. Its tables are additive and it never
  changes brain content. See [`../rsi/README.md`](../rsi/README.md).
