# OpenBrain — Deployment Pattern (n8n MCP)

This describes the architecture OpenBrain is actually run with, which differs from
the reference implementation in `src/` and `docs/setup.md` in two ways:

1. **Dedicated database and role** — OpenBrain runs in its own `openbrain`
   database owned by a dedicated `openbrain` role, not a shared database.
2. **MCP served by n8n** — the tools are exposed through an n8n **MCP Server
   Trigger** workflow rather than the standalone TypeScript `mcp-server`. The
   `src/` app is the original reference implementation and is not deployed in this
   setup. The workflows are exported in [`../n8n/`](../n8n/).

## Database layer

On a CloudNativePG (CNPG) cluster with PostgreSQL + pgvector:

- A dedicated `openbrain` database, owned by an `openbrain` role, created with the
  CNPG `Database` CR.
- The `openbrain` role's password is kept in a Kubernetes secret you control and
  pinned through the cluster's `spec.managed.roles`. CNPG enforces exactly that
  value, so the credential doesn't drift and a copy stored in your secret manager
  stays valid.
- The schema is applied to the `openbrain` database **as the `openbrain` role**,
  so the role owns its objects, using the migration runner in `db/`:
  | Migration | Adds |
  | --- | --- |
  | `0001_openbrain.sql` | `brain_entries`, indexes, `match_brain_entries`, `brain_stats` |
  | `0002_hybrid_search.sql` | `hybrid_brain_entries`: vector + full-text fused with RRF |
  | `0005_supersession.sql` | supersession marks, provenance, capture guard; retrieval hides superseded rows |
  | `0006_retrieval_feedback.sql` | `rsi` schema: logged retrieval wrappers and usefulness feedback |
  | `0007_reports_and_email_delivery.sql` | `reports` (ingest failures) and the alert delivery ledger |
  | `0008_rsi_defect_detector.sql` | `rsi` document defect review: scan and review tables, candidate and scan functions |

  Numbers 0003–0004 are intentionally unused here; the runner doesn't need
  contiguous numbers.

## MCP layer (n8n)

Use a **scoped** MCP Server Trigger workflow — not n8n's instance-level MCP server,
which exposes credential listing and control of every workflow. The scoped trigger
exposes only OpenBrain's tools.

- **Transport:** Streamable HTTP — `https://<your-n8n-host>/mcp/<path>`, with a
  bearer token (MCP Server Trigger **typeVersion 2**; the older typeVersion 1
  exposed an SSE endpoint at `/mcp/<path>/sse` and serialized concurrent tool
  calls per session — upgrade if you're still on it). The initialize response
  returns an `mcp-session-id` header; clients pass it back on `tools/call`.
- **Tools:**
  | Tool | Backing |
  | --- | --- |
  | `brain_stats` | Postgres tool → `select brain_stats()` |
  | `recent_entries` | Postgres tool → `rsi.recent(...)` (newest rows, superseded hidden unless `include_history`) |
  | `get_entry_by_id` | Postgres tool → `rsi.entry(...)` (exact lookup by UUID) |
  | `capture_thought` | sub-workflow: OpenAI embed → `insert into brain_entries` |
  | `semantic_search` | sub-workflow: OpenAI embed → `rsi.search(...)` over `hybrid_brain_entries` |
  | `record_retrieval_feedback` | Postgres tool → `rsi.record_feedback(...)` |

The two embedding tools are backed by sub-workflows (OpenAI embed → SQL). Their
sub-workflows must be **active** for the trigger to call them.

Every read goes through the `rsi.*` wrappers, which log the request and the ordered
result IDs (not content) and tag each hit with a `request_id`. A client can then
rate that retrieval with `record_retrieval_feedback`. Each trigger workflow passes a
fixed caller label (`mcp:openbrain`, `mcp:openbrain-openai`), so feedback is limited
to retrievals from the same endpoint. Details in [`../rsi/README.md`](../rsi/README.md).

**Per-consumer endpoints** — an n8n MCP Server Trigger validates exactly one
bearer. To give a second client its own independently-revocable credential (or a
read-only subset — e.g. no `capture_thought`), add a second trigger workflow on
its own path with its own bearer, wired to the same sub-workflows
(`n8n/openbrain-mcp-openai.json` is an example). Revoking that workflow or
credential cuts off that consumer without touching any other.

Recent n8n versions also let the trigger use **n8n OAuth2** authentication
(typeVersion 2.1) instead of a bearer: MCP clients that support OAuth register
themselves and the user consents once per machine, so no token sits in client
config. It's a good fit for a second consumer such as another vendor's agent.

Client config (any MCP client that supports remote Streamable HTTP servers):

```json
{
  "mcpServers": {
    "openbrain": {
      "type": "http",
      "url": "https://<your-n8n-host>/mcp/<path>",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Clients that support a headers helper (a command run at connect time) can fetch
the bearer from your secret manager instead of storing it in config, which also
picks up rotations without editing anything.

## Embeddings

OpenAI `text-embedding-3-small` (1536-dim), matching the `vector(1536)` column.
A self-hosted embedder is a viable alternative; it changes the vector dimension and
requires re-migrating the schema. Whatever you pick, treat the model as **locked**
once entries exist — swapping models strands every stored vector.

**One dedicated API key per consumer.** If the n8n search/capture path and a
batch ingester (or any other embedding consumer) share one OpenAI key, deleting
that key in the provider console — say, while cleaning up — silently takes down
*every* path at once, and the failures surface minutes to days apart. Mint a
separate, clearly-named key per consumer so a revocation only ever breaks the one
thing it names.

## Ingest failure alerts

The consume ingester writes an `ingest-failure` row to `public.reports` whenever a
file lands in `failed/`. A scheduled n8n workflow
(`ingester/workflow.ingest-failure-alerts.json`) claims unnotified rows under a
lease and emails one digest. See [`../ingester/README.md`](../ingester/README.md).

## Document defect review

A daily n8n workflow (`rsi/workflow.defect-detector.json`) runs
`rsi.scan_defects()` and queues ingested documents worth a human look: ones with
several fragment-sized chunks, chunks with extraction mojibake, or no search result
in 14 days. It only flags; dispositions are yours. Optional Prometheus alerts
(`rsi/monitoring/`) cover a failed, overdue or unmonitored run. See
[`../rsi/README.md`](../rsi/README.md).

## Notes

- Store the connection URL, the MCP bearer token(s), and the OpenAI key(s) in a
  secret manager — never in the repo. The workflow exports reference n8n
  credentials by placeholder id only.
- The n8n Postgres credential connects to CNPG's self-signed certificate with
  "Ignore SSL Issues" enabled and no explicit SSL mode set.
- Kubernetes consumers read secrets into env **at container start** — rotating a
  value in your secret manager reaches nothing until the k8s secret is re-synced
  *and* the workload restarted. Bake that into your rotation runbook.
