# OpenBrain Setup On Your Own Server

This version assumes you already have a server and want to avoid Supabase entirely.

OpenBrain has three pieces:

- Postgres with `pgvector` stores your thoughts and embeddings.
- A small Node capture server receives JSON, plain text, Slack slash commands, or WhatsApp Cloud API webhooks.
- A local MCP server lets AI tools search, list recent entries, inspect stats, and write new thoughts.

## 1. Prepare Postgres

Install Postgres and the `pgvector` extension on your server. Then create a database and user.

Run the migration:

```bash
psql "$DATABASE_URL" -f db/migrations/0001_openbrain.sql
```

The schema uses OpenAI `text-embedding-3-small`, which produces 1536-dimensional vectors. If you switch embedding models, update every `vector(1536)` reference before storing data.

> A sample standalone Postgres + pgvector deployment for Kubernetes is in `db/k3s/`.

## 2. Configure Environment

Copy `.env.example` into your server environment and fill in:

- `OPENAI_API_KEY`
- `DATABASE_URL`
- `OPENBRAIN_CAPTURE_TOKEN`
- `WHATSAPP_VERIFY_TOKEN`, if using WhatsApp
- `WHATSAPP_APP_SECRET`, required if using WhatsApp

Example:

```bash
export DATABASE_URL="postgres://openbrain:change-me@localhost:5432/openbrain"
export OPENAI_API_KEY="sk-your-key"
export OPENBRAIN_CAPTURE_TOKEN="change-this-long-random-token"
export OPENBRAIN_CAPTURE_PORT="8787"
```

## 3. Build And Run

```bash
npm install
npm run build
npm run capture
```

The capture server listens on `OPENBRAIN_CAPTURE_PORT`, defaulting to `8787`.

Test a manual capture:

```bash
curl -X POST "http://YOUR_SERVER:8787/capture" \
  -H "content-type: application/json" \
  -H "x-openbrain-token: YOUR_CAPTURE_TOKEN" \
  -d "{\"content\":\"I decided to run OpenBrain on my own server with plain Postgres.\",\"source\":\"manual\"}"
```

## 4. Add WhatsApp Capture

WhatsApp capture uses the Meta WhatsApp Cloud API. This works with a WhatsApp Business Platform phone number, not a normal personal WhatsApp account.

In the Meta developer dashboard:

1. Create or open a Meta app with WhatsApp enabled.
2. Add or use a WhatsApp Business Account and Cloud API phone number.
3. Set the webhook callback URL to:

```text
https://YOUR_DOMAIN/capture
```

4. Set the verify token to the same value as `WHATSAPP_VERIFY_TOKEN`.
5. Subscribe the webhook to the `messages` field.
6. Set `WHATSAPP_APP_SECRET` to your Meta app secret so the capture server can verify inbound webhook signatures.

When someone sends a text message to the WhatsApp Business number, Meta sends a webhook to the capture server. The server stores each inbound text message with:

- `source`: `whatsapp`
- `source_ref`: sender phone number
- `metadata`: Meta message ID, timestamp, sender, contacts, and phone number ID

The current starter captures text messages only. Images, audio, voice notes, and documents need a media download/transcription step before embedding.

## 5. Add Slack Capture

Create a Slack slash command such as `/brain`.

Use this request URL:

```text
https://YOUR_DOMAIN/capture?token=YOUR_CAPTURE_TOKEN
```

When you type:

```text
/brain Sarah is thinking about leaving her job to start a consulting business after the reorg.
```

Slack sends form data to the capture server, which embeds and stores the thought.

## 6. Run The MCP Server

The MCP server reads the same `DATABASE_URL` and `OPENAI_API_KEY`.

```bash
node /path/to/openbrain/dist/mcp-server.js
```

Expose these environment variables to the MCP process:

- `OPENAI_API_KEY`
- `DATABASE_URL`
- `OPENBRAIN_EMBEDDING_MODEL`

## MCP Tools

- `semantic_search`: find memories by meaning.
- `recent_entries`: browse recent captures.
- `brain_stats`: see counts, sources, and topics.
- `capture_thought`: write into OpenBrain from any MCP-capable client.
