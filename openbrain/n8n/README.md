# OpenBrain MCP — n8n workflows

Workflow exports for serving OpenBrain over MCP from n8n. See
[`../docs/deployment-live.md`](../docs/deployment-live.md) for the full picture and
[`../rsi/README.md`](../rsi/README.md) for the retrieval-feedback contract.

| File | Workflow | Role |
| --- | --- | --- |
| `openbrain-mcp.json` | **OpenBrain MCP** | MCP Server Trigger (path `openbrain`): all tools, including exact-ID lookup and feedback |
| `openbrain-mcp-openai.json` | **OpenBrain MCP (openai)** | Second consumer endpoint (path `openbrain-openai`) with its own bearer: shared search, feedback, capture |
| `openbrain-capture.json` | **OpenBrain: capture** | sub-workflow: OpenAI embed → `insert into brain_entries` |
| `openbrain-search.json` | **OpenBrain: search** | sub-workflow: OpenAI embed → logged `rsi.search` over hybrid retrieval |

Requires migrations 0001–0007 (`../db/`); the tools call `rsi.*` and
`hybrid_brain_entries`.

## Import

Import each JSON in the n8n UI (Workflows → Import from File), or via the public
API (`POST /api/v1/workflows`).

Order matters: import the two sub-workflows first, then the trigger workflows. After
import you must:

1. Create the n8n credentials and point every node at them. The exports carry
   placeholder credential ids (`REPLACE_WITH_*`): a Postgres credential for the
   `openbrain` database, an OpenAI credential, and one HTTP Bearer credential per
   trigger workflow. For CNPG's self-signed certificate, the Postgres credential
   that works is **Ignore SSL Issues = on** with no explicit SSL mode.
2. In each trigger workflow, set the `semantic_search` / `capture_thought` tool nodes
   to the ids n8n assigned to the imported sub-workflows (placeholders
   `REPLACE_WITH_SEARCH_WORKFLOW_ID` / `REPLACE_WITH_CAPTURE_WORKFLOW_ID`).
3. **Activate all of them.** n8n requires a called sub-workflow to be active, not just
   the trigger workflow.

To make the second endpoint read-only, delete its `capture_thought` node.

## Notes

- These exports contain **no secret values**. Credentials are referenced by id/name
  only; the secret data lives in n8n's encrypted credential store.
- The MCP endpoint is **Streamable HTTP** at `https://<your-n8n-host>/mcp/<path>`. The
  trigger is `mcpTrigger` typeVersion 2; the old SSE transport (`/sse` + `/messages`)
  is gone, and registering a client with a `/sse` suffix fails.
- The `capture_thought` / `semantic_search` tools pass the LLM's arguments to their
  sub-workflow via a `workflowInputs` mapping built from
  `$fromAI('name', 'description', 'type', <default>)`. Supplying a default makes that
  argument optional.
- Each trigger passes a fixed `retrieval_caller` (`mcp:openbrain`,
  `mcp:openbrain-openai`) so telemetry and feedback are attributed per endpoint. Rename
  them if you like, but keep them distinct per endpoint and update the matching
  literals in the Postgres tool nodes.
