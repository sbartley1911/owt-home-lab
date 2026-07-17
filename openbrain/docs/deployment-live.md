# OpenBrain — Deployment Pattern (n8n MCP)

This describes the architecture OpenBrain is actually run with, which differs from
the reference implementation in `src/` and `docs/setup.md` in two ways:

1. **Dedicated database and role** — OpenBrain runs in its own `openbrain`
   database owned by a dedicated `openbrain` role, not a shared database.
2. **MCP served by n8n** — the tools are exposed through an n8n **MCP Server
   Trigger** workflow rather than the standalone TypeScript `mcp-server`. The
   `src/` app is the original reference implementation and is not deployed in this
   setup.

## Database layer

On a CloudNativePG (CNPG) cluster with PostgreSQL + pgvector:

- A dedicated `openbrain` database, owned by an `openbrain` role, created with the
  CNPG `Database` CR.
- The `openbrain` role's password is kept in a Kubernetes secret you control and
  pinned through the cluster's `spec.managed.roles`. CNPG enforces exactly that
  value, so the credential doesn't drift and a copy stored in your secret manager
  stays valid.
- The schema (`db/migrations/0001_openbrain.sql`) is applied to the `openbrain`
  database **as the `openbrain` role**, so the role owns its objects.

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
  | `recent_entries` | Postgres tool → newest rows |
  | `capture_thought` | sub-workflow: OpenAI embed → `insert into brain_entries` |
  | `semantic_search` | sub-workflow: OpenAI embed → `match_brain_entries` |

The two embedding tools are backed by sub-workflows (OpenAI embed → SQL). Their
sub-workflows must be **active** for the trigger to call them.

**Per-consumer endpoints** — an n8n MCP Server Trigger validates exactly one
bearer. To give a second client its own independently-revocable credential (or a
read-only subset — e.g. no `capture_thought`), add a second trigger workflow on
its own path with its own bearer, wired to the same sub-workflows. Revoking that
workflow or credential cuts off that consumer without touching any other.

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

## Notes

- Store the connection URL, the MCP bearer token, and the OpenAI key(s) in a secret
  manager — never in the repo.
- The n8n Postgres credential connects to CNPG's self-signed certificate with
  "Ignore SSL Issues" enabled and no explicit SSL mode set.
- Kubernetes consumers read secrets into env **at container start** — rotating a
  value in your secret manager reaches nothing until the k8s secret is re-synced
  *and* the workload restarted. Bake that into your rotation runbook.
