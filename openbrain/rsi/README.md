# Retrieval feedback, eval and defect review

Logs every MCP retrieval and lets a client say whether the result was useful, so you
can find the searches that come back empty, error, or miss. On top of that log: a
scored eval suite for retrieval, and a daily scan that flags documents worth a
human look.

## Components

- `../db/migrations/0006_retrieval_feedback.sql` adds the `rsi` schema: request and
  result logging, read wrappers (`rsi.search`, `rsi.recent`, `rsi.entry`), response
  formatting, and `rsi.record_feedback`. Brain content, ranking SQL, and corpus
  permissions are unchanged.
- The workflows in `../n8n/` call those wrappers instead of querying `brain_entries`
  directly.
- `failures.sql` reports recent requests by category with feedback coverage.
- `eval.mjs` and `run-live.mjs` run a versioned retrieval suite against the search
  endpoint and score it.
- `../db/migrations/0008_rsi_defect_detector.sql` adds the document defect review
  queue. `workflow.defect-detector.json` runs the scan daily; `reviews.sql` reads the
  queue.
- `monitoring/` exposes the detector's n8n run status to Prometheus and alerts on
  failed, overdue or missing runs.
- `tests/` runs the migrations' SQL against PGlite (with pgvector for 0006) and
  synthetic entries. `tests/fixtures/baseline-search.sql` holds the retrieval
  functions the wrappers sit on (as left by migrations 0002 and 0005).

## Response and feedback contract

Each returned hit keeps its normal fields and gains `request_id`, `outcome`, and
`telemetry`. Search also exposes the stable entry `id`. An empty response or a
retrieval failure returns one metadata-only row with `outcome=empty` or
`outcome=error`; consumers must not count that row as a hit.

When `telemetry=recorded`, submit `record_retrieval_feedback` with the request ID, a
caller-generated UUID `feedback_id`, and `usefulness` (`useful`, `partly_useful`, or
`not_useful`). Optional fields are `reason` and `expected_entry_id`. Reuse a feedback
UUID only for an identical retry; use a new UUID for a revised rating. Reports use the
latest rating and keep the earlier ones. Missing feedback means unreviewed, not
failure or success.

Caller identity is fixed by each MCP workflow (`mcp:openbrain`,
`mcp:openbrain-openai`). Feedback is accepted only for requests from the same
endpoint. Endpoints use shared bearers, so this is endpoint attribution, not verified
individual attribution; the database functions trust their credential holders. Direct
invocation of the search sub-workflow without a caller is labeled
`n8n:direct-search`.

Search uses `n8n:search:<execution-id>` as its request ID, so a retry inside one n8n
execution maps to the same log row. Direct recent/ID tools allocate a database UUID
per call. A client repeating a tool call is a new retrieval. Reusing a request ID with
different data produces an explicit telemetry failure instead of misattributing
results.

## What is stored

Logs hold the query or lookup arguments, timestamp, endpoint, ordered entry IDs,
source references, and scores. They don't copy content or embeddings. Query text can
itself be sensitive, so keep these tables in the private database. No retention job is
included; add one if you need it. Reading the reports needs table access; the MCP
roles only get function execution.

## Failure behavior

If the telemetry insert fails, that record rolls back and the caller still gets the
successful retrieval, with `telemetry=failed` and a warning. Embedding or query
failures in the search workflow record a generic error code; raw database error text
is never logged. A full database outage can prevent both retrieval and logging; those
failures are visible to callers but absent from the reports. There is no durable retry
queue.

## Verify

```bash
npm install     # or: pnpm install --frozen-lockfile
npm test
```

The tests exercise the real migration SQL on PGlite + pgvector, the SQL generated in
`../n8n/openbrain-mcp.json`, failure branches, the report query, the eval scorer and
MCP transport (against a fake server), the defect scan, and the detector health view.
They don't run n8n or a real MCP transport; after deploying, run a known search, an
empty filtered search, `recent_entries`, and `get_entry_by_id` through each endpoint,
then read the rows back by request ID.

## Report

```bash
psql -v days=7 -f failures.sql
```

Run it as a role that can read the `rsi` tables. Categories: `retrieval_error`,
`empty_results`, `not_useful`, `partly_useful`, `useful`, `unreviewed`.

## Eval baseline

A suite is JSON with a `version` and a list of `cases`. Each case has a unique `id`,
a `query`, a result `count` (the K the case is scored at), one or more
`expected_ids` (entry UUIDs from your brain), and an optional `source` filter. Pick
expected IDs by inspecting the chunks that should answer each query; a small seed set
is a regression check, not a full relevance judgment.

Supply the endpoint and its bearer through the environment, never on the command
line, then run:

```bash
export OPENBRAIN_MCP_URL=https://<your-mcp-host>/mcp/openbrain
node run-live.mjs suite.json evidence.json > baseline.json
node eval.mjs suite.json evidence.json      # re-score saved evidence
```

The runner calls the `semantic_search` tool over streamable HTTP. A host that already
has an MCP client can pass its own search function to `runSuite(suite, search)`
instead. Expired credentials fail visibly; the runner does not refresh tokens.

Reports give per-case rank, request ID and hit/miss/error, plus hit rate at each
case's K and mean reciprocal rank. Errors stay in the all-case denominator and are
counted apart from misses. Evidence is bound to the suite's SHA-256, and empty or
incomplete evidence fails closed. Evidence files hold memory content: keep them
private and temporary, and don't commit them. If you store the suite in the brain
itself, it can show up in unfiltered searches; exact expected IDs stop it counting as
a hit, but it can still move rankings. Re-ingesting or retiring an expected entry
needs a new suite version.

## Document defect review

Migration 0008 adds review and scan tables and two functions.
`rsi.defect_candidates(now())` is read-only; `rsi.scan_defects()` writes only the new
tables. Candidates group active `consume` chunks by source and document ref.

- `not_observed`: no semantic-search result in the last 14 days. Only reported after
  at least seven days of telemetry and 20 successful searches, with a seven-day grace
  period after a document changes. Recent-entry and ID lookups don't count. This does
  not prove a document was never used; unlogged clients, outages and low demand all
  limit the evidence.
- `short_chunks`: three or more bodies under 120 characters.
- `garbled_chunks`: a chunk with at least three replacement or mojibake markers.

These are review heuristics; headings, tables, code and short prose can all be valid.
Evidence holds counts and up to five entry UUIDs, never copied content. Repeated
scans update observations without reopening dismissed or resolved rows, and never
resolve a row on their own. Read the queue and scan history with `psql -f reviews.sql`
as a role that can read the `rsi` tables.

Deploy:

1. Back up the database. Edit the role list at the end of 0008 to the role n8n
   connects as, then run `python db/migrate.py` (see [`../db/README.md`](../db/README.md)).
   0008 needs 0006 applied and PostgreSQL 15 or later. Don't re-run it by hand: an
   existing table or function aborts it instead of being overwritten.
2. Import `workflow.defect-detector.json` inactive. Bind its Postgres node to your
   OpenBrain credential (it ships with `REPLACE_WITH_POSTGRES_CREDENTIAL_ID`), set the
   workflow timezone (it ships as UTC, at 06:15), run it once by hand, and inspect
   the scan and review rows.
3. Publish it. Check that a scheduled run lands and the scan timestamp moves.

Roll back by unpublishing the workflow. The tables are additive; keep the review
evidence. Nothing here edits, deletes, re-ingests or re-ranks brain content.

## Detector health alerts

Without alerts, a failed or stopped detector is only visible in n8n's execution
history. `monitoring/` covers that for a CloudNativePG-hosted n8n database and the
Prometheus Operator:

1. Replace `REPLACE_WITH_DETECTOR_WORKFLOW_ID` in `detector-health.sql` (two places)
   and run it in the n8n database as its owner. It creates
   `rsi_monitoring.detector_health`, a view over n8n's `execution_entity` that
   exposes only the detector's last result and timestamps. Manual runs, other
   workflows and soft-deleted executions are ignored. The CNPG metrics exporter gets
   read access to the view, not to executions.
2. Apply `detector-metrics.yaml` in the CNPG cluster's namespace and add it to the
   cluster's `monitoring.customQueriesConfigMap`, as its header shows.
3. Fill in the placeholders in `detector-alerts.yaml` (Prometheus release label,
   workflow ID, n8n host) and apply it.

Alerts: `OpenBrainRSIDetectorFailed` (the latest automatic run failed, or one failed
in the last five minutes), `OpenBrainRSIDetectorOverdue` (no success in 26 hours,
which allows for a 25-hour daylight-saving day), and
`OpenBrainRSIDetectorTelemetryMissing` (the metric is absent). If your n8n database
isn't on CNPG, the view still works with any exporter that can run its query.
