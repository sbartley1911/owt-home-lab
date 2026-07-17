# OpenBrain consume-folder ingester

Drop a file into a watched folder → it's text-extracted, chunked, embedded, and stored in
OpenBrain's `brain_entries` (searchable), then archived and eventually purged. A small
polling pod, not part of the capture server — useful when your automation platform can't
touch the filesystem, and a good fit for batch document ingestion generally.

Handles markdown, text, PDF, Office (Word/Excel/PowerPoint, modern + legacy), OpenDocument,
RTF, HTML, CSV, and images — with **OCR** for scanned PDFs and images, all on-cluster.

## How it works

`inbox/` → claim (rename to `work/`) → extract text → chunk by markdown heading (or by size
for non-markdown) → embed each chunk (`text-embedding-3-small`, 1536-dim) → upsert into
`brain_entries` (`source='consume'`, `source_ref='<file>#<idx>'`, `entry_type='document'`,
`on conflict … do update`) → `archive/` on success (`failed/` on error). `archive/` is
purged after `ARCHIVE_RETAIN_DAYS`, measured from archive time.

**Extraction** — markdown/text is read directly (keeps heading-based chunking). Everything
else goes to **[Apache Tika](https://tika.apache.org/)** (use the `-full` image; it bundles
Tesseract for OCR). An Office file Tika can't read falls back to
**[Gotenberg](https://gotenberg.dev/)** (LibreOffice → PDF) and back through Tika. OCR runs
on your own infrastructure — no per-page cloud cost, no document images leaving.

Chunking merges sections `< MIN_CHARS` and hard-splits `> MAX_CHARS` at paragraph
boundaries, then hard-slices by raw characters as a backstop — flat spreadsheet/CSV text has
no blank-line breaks, so without this a whole sheet becomes one chunk that exceeds the
model's token limit. Re-dropping an edited file with the same name refreshes its chunks
(idempotent on the `(source, source_ref)` unique constraint).

## Configuration (all via env)

| Env | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | Postgres with the OpenBrain schema + pgvector |
| `OPENAI_API_KEY` | — (required) | for embeddings — give the ingester its **own** key (see Notes) |
| `CONSUME_DIR` | `/data/consume` | holds `inbox/ work/ archive/ failed/` |
| `TIKA_URL` | `http://tika:9998` | Apache Tika (`-full`, with Tesseract) |
| `GOTENBERG_URL` | `http://gotenberg:3000` | Gotenberg (Office→PDF fallback) |
| `EMBED_MODEL` | `text-embedding-3-small` | |
| `POLL_SECONDS` | `10` | |
| `SETTLE_SECONDS` | `5` | a file must be unmodified this long before it's claimed |
| `ARCHIVE_RETAIN_DAYS` | `30` | |

## Deploy sketch (Kubernetes)

Run three things in a namespace: this ingester, Tika, and Gotenberg.

```yaml
# Tika (bundles Tesseract for OCR) — Deployment + Service on :9998
image: apache/tika:latest-full
# Gotenberg (LibreOffice→PDF) — Deployment + Service on :3000
image: gotenberg/gotenberg:8
# Ingester — python:3.12-slim, mounts a shared/NFS drop folder at /data/consume
#   pip install "psycopg[binary]" requests ; python ingest.py
#   env: DATABASE_URL, OPENAI_API_KEY, TIKA_URL, GOTENBERG_URL
```

**Drop folder** — any shared filesystem the pod can mount (an NFS export works well and lets
you drop files from outside the cluster). Align the pod's `runAsUser`/`runAsGroup` with the
owner of the folder so drops from another host and the pod's own moves share one identity —
then the folder can stay owner-writable rather than world-writable.

## Key hygiene & rotation

- **Dedicated API key.** Don't share the ingester's `OPENAI_API_KEY` with any other
  embedding consumer (like the capture/search path). A shared key means one console
  deletion or rotation silently breaks every consumer at once — and because this pod
  fails quietly into `failed/`, it can be the last place you notice. One
  clearly-named key per consumer makes every revocation surgical.
- **Rotation reaches nothing by itself.** The pod reads `OPENAI_API_KEY` from its
  Kubernetes secret **at container start**. After rotating the key: re-sync the k8s
  secret, restart the deployment (`kubectl rollout restart`), then move anything in
  `failed/` back to `inbox/` to re-ingest. Skip any step and drops keep failing with
  401s while the pod looks healthy.

## Notes

- **No built-in failure alerting.** Files piling into `failed/` raise no alarm on their
  own — a dead credential can sit unnoticed while every drop quietly fails. Watch
  `failed/` (or wire an alert on it); the pod also logs a full traceback to stdout on
  any failure. Nothing is lost — move the file back to `inbox/` to retry.
- Non-markdown extracts as flat text, so it chunks by size (heading `(whole file)`), losing
  page/sheet/slide structure. Adequate for search.
- Scanned/image-only content relies on Tika's Tesseract OCR — quality tracks the scan.
