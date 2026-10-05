"""Integration tests; PGHOST/PGPORT must select a disposable PostgreSQL server."""
import contextlib
import io
import os
from pathlib import Path
import tempfile
import unittest
import uuid

import psycopg
from psycopg import sql

from migrate import migrate, migration_sql

MIGRATIONS = Path(__file__).parent / "migrations"


class MigrationTests(unittest.TestCase):
    def setUp(self):
        if os.environ.get("MIGRATION_TEST_DISPOSABLE") != "yes":
            self.fail("Set MIGRATION_TEST_DISPOSABLE=yes only for a disposable server")
        self.previous_db = os.environ.get("PGDATABASE", "postgres")
        self.db = "migrate_" + uuid.uuid4().hex
        with psycopg.connect(dbname=self.previous_db, autocommit=True) as conn:
            conn.execute(sql.SQL("CREATE DATABASE {}").format(sql.Identifier(self.db)))
        os.environ["PGDATABASE"] = self.db
        with psycopg.connect(autocommit=True) as conn:
            conn.execute("CREATE EXTENSION vector")

    def tearDown(self):
        os.environ["PGDATABASE"] = self.previous_db
        with psycopg.connect(autocommit=True) as conn:
            conn.execute(sql.SQL("DROP DATABASE {}").format(sql.Identifier(self.db)))

    def run_migrations(self, through=None, directory=MIGRATIONS):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            migrate(directory, through)
        return output.getvalue()

    def versions(self):
        with psycopg.connect() as conn:
            return conn.execute(
                "SELECT version, applied_at FROM public.schema_migrations ORDER BY version"
            ).fetchall()

    def test_full_set_twice_preserves_versions_and_data(self):
        first = self.run_migrations()
        before = self.versions()
        with psycopg.connect(autocommit=True) as conn:
            conn.execute("INSERT INTO public.reports(report_type, title, body_md) "
                         "VALUES ('fixture', 'Fixture', 'fixture')")
        second = self.run_migrations()
        self.assertEqual(self.versions(), before)
        expected = len(list(MIGRATIONS.glob("[0-9][0-9][0-9][0-9]_*.sql")))
        self.assertEqual(first.count("APPLY "), expected)
        self.assertEqual(second.count("SKIP "), expected)
        self.assertNotIn("APPLY ", second)
        with psycopg.connect() as conn:
            self.assertEqual(conn.execute("SELECT count(*) FROM public.reports "
                                          "WHERE report_type='fixture'").fetchone()[0], 1)

    def test_tracked_0002_applies_only_0005(self):
        self.run_migrations("0002")
        result = self.run_migrations("0005")
        self.assertEqual(result.count("SKIP "), 2)
        self.assertEqual(result.count("APPLY "), 1)
        self.assertIn("APPLY 0005_supersession.sql", result)

    def test_failed_file_rolls_back_schema_and_tracking(self):
        self.run_migrations("0002")
        before = self.versions()
        with tempfile.TemporaryDirectory() as temp:
            Path(temp, "9999_failure.sql").write_text(
                "BEGIN; CREATE TABLE public.should_rollback(id int); SELECT 1/0; COMMIT;"
            )
            with self.assertRaises(psycopg.errors.DivisionByZero):
                self.run_migrations(directory=temp)
        self.assertEqual(self.versions(), before)
        with psycopg.connect() as conn:
            self.assertIsNone(conn.execute("SELECT to_regclass('public.should_rollback')").fetchone()[0])

    def test_untracked_existing_database_is_not_baselined(self):
        with psycopg.connect(autocommit=True) as conn:
            conn.execute((MIGRATIONS / "0001_openbrain.sql").read_text(encoding="utf-8"))
        with self.assertRaisesRegex(RuntimeError, "Existing untracked"):
            self.run_migrations()


if __name__ == "__main__":
    unittest.main(verbosity=2)
