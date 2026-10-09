"""Apply versioned SQL files atomically; connection settings use libpq PG* env vars."""
import argparse
from pathlib import Path
import re

import psycopg


def migration_sql(path):
    text = path.read_text(encoding="utf-8-sig")
    start = re.match(r"\A(?:\s|--[^\n]*(?:\n|$))*BEGIN\s*;", text, re.I)
    end = re.search(r"\bCOMMIT\s*;\s*\Z", text, re.I)
    if bool(start) != bool(end):
        raise ValueError(f"{path.name}: incomplete outer transaction wrapper")
    if start:
        text = text[start.end():end.start()]
    return text


def migrate(directory, through=None):
    if through and not re.fullmatch(r"\d{4}", through):
        raise ValueError("--through must be a four-digit version")
    paths = sorted(Path(directory).glob("[0-9][0-9][0-9][0-9]_*.sql"))
    if through:
        paths = [p for p in paths if p.name[:4] <= through]
    if not paths:
        raise ValueError("No migration files selected")
    with psycopg.connect(autocommit=True) as conn:
        conn.execute("SELECT pg_advisory_lock(hashtext('openbrain.db.migrations'))")
        tracked, existing = conn.execute(
            "SELECT to_regclass('public.schema_migrations'), "
            "to_regclass('public.brain_entries')"
        ).fetchone()
        if not tracked and existing:
            raise RuntimeError(
                "Existing untracked database: confirm applied versions before "
                "baselining schema_migrations; no migration was run"
            )
        conn.execute(
            "CREATE TABLE IF NOT EXISTS public.schema_migrations ("
            "version text PRIMARY KEY, "
            "applied_at timestamptz NOT NULL DEFAULT now())"
        )
        applied = {r[0] for r in conn.execute(
            "SELECT version FROM public.schema_migrations"
        )}
        for path in paths:
            if path.name in applied:
                print(f"SKIP {path.name}: already applied")
                continue
            sql = migration_sql(path)
            with conn.transaction():
                conn.execute(sql)
                conn.execute(
                    "INSERT INTO public.schema_migrations(version) VALUES (%s)",
                    (path.name,),
                )
            print(f"APPLY {path.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path,
                        default=Path(__file__).parent / "migrations")
    parser.add_argument("--through", metavar="VERSION")
    args = parser.parse_args()
    migrate(args.directory, args.through)
