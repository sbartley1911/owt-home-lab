# Retrieval feedback

Logs every MCP retrieval and lets a client say whether the result was useful, so you
can find the searches that come back empty, error, or miss.

## Components

- `../db/migrations/0006_retrieval_feedback.sql` adds the `rsi` schema: request and
  result logging, read wrappers (`rsi.search`, `rsi.recent`, `rsi.entry`), response
  formatting, and `rsi.record_feedback`. Brain content, ranking SQL, and corpus
  permissions are unchanged.
- The workflows in `../n8n/` call those wrappers instead of querying `brain_entries`
  directly.
- `failures.sql` reports recent requests by category with feedback coverage.
- `tests/` runs the migration's SQL against PGlite with pgvector and synthetic entries.
  `tests/fixtures/baseline-search.sql` holds the retrieval functions the wrappers sit on
  (as left by migrations 0002 and 0005).

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
`../n8n/openbrain-mcp.json`, failure branches, and the report query. They don't run
n8n or a real MCP transport; after deploying, run a known search, an empty filtered
search, `recent_entries`, and `get_entry_by_id` through each endpoint, then read the
rows back by request ID.

## Report

```bash
psql -v days=7 -f failures.sql
```

Run it as a role that can read the `rsi` tables. Categories: `retrieval_error`,
`empty_results`, `not_useful`, `partly_useful`, `useful`, `unreviewed`.
