"""Integration tests: PG* variables must point to a disposable PostgreSQL server."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import uuid

import psycopg
from psycopg import sql

HERE = Path(__file__).parent
MIGRATION = HERE.parent / 'db/migrations/0007_reports_and_email_delivery.sql'
CLAIM = (HERE / 'claim_alerts.sql').read_text(encoding='utf-8')
ACK = (HERE / 'ack_alerts.sql').read_text(encoding='utf-8').replace('$1', '%s').replace('$2', '%s')


class AlertTests(unittest.TestCase):
    def setUp(self):
        if os.environ.get('MIGRATION_TEST_DISPOSABLE') != 'yes':
            self.fail('Only run against a disposable PostgreSQL server')
        self.database = 'alerts_' + uuid.uuid4().hex
        with psycopg.connect(autocommit=True) as admin:
            admin.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(self.database)))
        self.conn = psycopg.connect(dbname=self.database, autocommit=True)

    def tearDown(self):
        self.conn.close()
        with psycopg.connect(autocommit=True) as admin:
            admin.execute(sql.SQL('DROP DATABASE {} WITH (FORCE)').format(sql.Identifier(self.database)))

    def migrate(self):
        with self.conn.transaction():
            self.conn.execute(MIGRATION.read_text(encoding='utf-8'))

    def fail_ingest(self):
        # Empty markdown raises before any embedding call; execute the real main loop once.
        spec = importlib.util.spec_from_file_location('ingest_fixture', HERE / 'ingest.py')
        ingest = importlib.util.module_from_spec(spec)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'DATABASE_URL': self.conn.info.dsn,
            'OPENAI_API_KEY': 'unused-fixture', 'CONSUME_DIR': directory,
            'SETTLE_SECONDS': '0',
        }):
            spec.loader.exec_module(ingest)
            ingest.ensure_dirs()
            Path(ingest.INBOX, 'empty-test.md').write_text('')
            output = io.StringIO()
            connection = psycopg.connect(self.conn.info.dsn)
            try:
                with patch.object(ingest.psycopg, 'connect', return_value=connection), \
                     patch.object(ingest.time, 'sleep', side_effect=KeyboardInterrupt), \
                     contextlib.redirect_stdout(output):
                    with self.assertRaises(KeyboardInterrupt):
                        ingest.main()
                self.assertTrue(Path(ingest.FAILED, 'empty-test.md').exists())
            finally:
                connection.close()
            return output.getvalue()

    def seed(self, count=1, report_type='ingest-failure'):
        self.conn.execute(
            "INSERT INTO public.reports(report_type,title,body_md) "
            "SELECT %s,'fixture','fixture' FROM generate_series(1,%s)", (report_type, count))

    def claim(self, conn=None):
        return (conn or self.conn).execute(CLAIM).fetchone()[0]

    def test_real_failure_before_and_after_migration(self):
        before = self.fail_ingest()
        self.assertIn('FAILED empty-test.md', before)
        self.assertIn('report-failure-error', before)
        self.assertIn('UndefinedTable', before)
        self.migrate()
        after = self.fail_ingest()
        self.assertIn('FAILED empty-test.md', after)
        self.assertNotIn('report-failure-error', after)
        row = self.conn.execute('SELECT report_type,meta FROM reports').fetchone()
        self.assertEqual(row[0], 'ingest-failure')
        self.assertEqual(row[1]['file'], 'empty-test.md')

    def test_replay_preserves_existing_reports(self):
        self.migrate()
        self.seed()
        before = self.conn.execute('SELECT * FROM reports').fetchall()
        self.migrate()
        self.assertEqual(self.conn.execute('SELECT * FROM reports').fetchall(), before)

    def test_delivery_dedup_and_type_filter(self):
        self.migrate()
        self.seed(2)
        self.seed(1, 'canary-alert')
        claimed = self.claim()
        self.assertEqual(len(claimed), 2)
        self.assertEqual(self.claim(), [])
        self.assertEqual(self.conn.execute(ACK, ('fixture-message', json.dumps(claimed))).fetchone()[0], 2)
        self.assertEqual(self.claim(), [])

    def test_expired_retry_rejects_old_ack(self):
        self.migrate()
        self.seed()
        old = self.claim()
        self.conn.execute("UPDATE report_email_delivery SET lease_until=now()-interval '1 second'")
        new = self.claim()
        self.assertNotEqual(old[0]['lease_token'], new[0]['lease_token'])
        self.assertEqual(self.conn.execute(ACK, ('old-message', json.dumps(old))).fetchone()[0], 0)
        self.assertEqual(self.conn.execute(ACK, ('new-message', json.dumps(new))).fetchone()[0], 1)
        self.assertEqual(self.conn.execute('SELECT attempts FROM report_email_delivery').fetchone()[0], 2)

    def test_concurrent_claims_have_one_winner(self):
        from concurrent.futures import ThreadPoolExecutor
        from threading import Barrier
        self.migrate()
        self.seed(4)
        barrier = Barrier(2)
        def run():
            with psycopg.connect(self.conn.info.dsn, autocommit=True) as other:
                barrier.wait()
                return self.claim(other)
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: run(), range(2)))
        self.assertEqual(sorted(map(len, results)), [0, 4])


if __name__ == '__main__':
    unittest.main(verbosity=2)
