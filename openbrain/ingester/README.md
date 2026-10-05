# OpenBrain consume-folder ingester

Drop a file into a watched folder → it's text-extracted, chunked, embedded, and stored in
OpenBrain's `brain_entries` (searchable), then archived and eventually purged. A small
polling pod, not part of the capture server — useful when your automation platform can't
touch the filesystem, and a good fit for batch document ingestion generally.

Handles markdown, text, PDF, Office (Word/Excel/PowerPoint, modern + legacy), OpenDocument,
RTF, HTML, CSV, and images — with **OCR** for scanned PDFs and images, all on-cluster.

## How it works

`inbox/` → claim (rename to `work/`) → extract text → chunk → embed the chunks in batches
(`text-embedding-3-small`, 1536-dim) → write to `brain_entries` (`source='consume'`,
`source_ref='<file>#<idx>'`, `entry_type='document'`) → `archive/` on success (`failed/` on
error). `archive/` is purged after `ARCHIVE_RETAIN_DAYS`, measured from archive time.

**Extraction** — markdown/text is read directly. Everything else goes to
**[Apache Tika](https://tika.apache.org/)** (use the `-full` image; it bundles Tesseract for
OCR). An Office file Tika can't read falls back to **[Gotenberg](https://gotenberg.dev/)**
(LibreOffice → PDF) and back through Tika. OCR runs on your own infrastructure — no
per-page cloud cost, no document images leaving. Tika replies `text/plain` without a
charset, so the ingester decodes it explicitly as UTF-8 (otherwise `®` and friends come
out as mojibake).

**Chunking** is sized for retrieval, not just for the embedding limit: paragraphs are
packed to about 1,100 characters (~275 tokens) with a hard ceiling of 2,400, and sections
under 400 characters merge into the next one.

- Markdown (`.md`, `.markdown`) splits on its `#` headings.
- Everything else (Tika's flat text) splits on conservatively detected section headings:
  `CHAPTER 4` / `APPENDIX B`, numbered headings like `14.1 Managing Rules`, and short
  ALL-CAPS lines, but only when prose follows (so SQL or code output isn't promoted to a
  heading). A heading that repeats within a document, like a running page header, gets a
  continuation index.
- A chunk with no detected heading titles itself by its own first line. The title is
  prepended to the embedded text, so a shared placeholder title would pull unrelated
  chunks toward one meaningless vector.
- Text with no paragraph breaks (spreadsheets, CSV dumps) is hard-sliced at the ceiling
  so an embed call can never exceed the model's token limit.

**Re-ingest is idempotent.** Chunks upsert on `(source, source_ref)`, and in the same
transaction any older chunk of the same file whose stored `sha256` differs is deleted. A
re-dropped document that now chunks shorter doesn't leave stale trailing chunks behind.

## Configuration (all via env)

| Env | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | — (required) | Postgres with the OpenBrain schema + pgvector |
| `OPENAI_API_KEY` | — (required) | for embeddings — give the ingester its **own** key (see below) |
| `CONSUME_DIR` | `/data/consume` | holds `inbox/ work/ archive/ failed/` |
| `TIKA_URL` | `http://tika:9998` | Apache Tika (`-full`, with Tesseract) |
| `GOTENBERG_URL` | `http://gotenberg:3000` | Gotenberg (Office→PDF fallback) |
| `EMBED_MODEL` | `text-embedding-3-small` | |
| `POLL_SECONDS` | `10` | |
| `SETTLE_SECONDS` | `5` | a file must be unmodified this long before it's claimed |
| `ARCHIVE_RETAIN_DAYS` | `30` | |

## Deploy (Kubernetes)

Manifests are in [`../k8s/`](../k8s/): namespace (`restricted` Pod Security), a static
NFS PV/PVC for the drop folder, the ingester, Tika, and Gotenberg.

```bash
kubectl apply -f k8s/00-namespace.yaml
# edit <nfs-server>/<export-path> first
kubectl apply -f k8s/05-ingest-pv-pvc.yaml
kubectl create configmap openbrain-consume-code -n openbrain \
  --from-file=ingest.py=ingester/ingest.py --dry-run=client -o yaml | kubectl apply -f -
# values come from your secret manager; capture them into variables, never echo them
kubectl create secret generic openbrain-consume-secrets -n openbrain \
  --from-literal=DATABASE_URL="$DB" --from-literal=OPENAI_API_KEY="$OA"
kubectl apply -f k8s/10-consume-ingester.yaml -f k8s/11-tika.yaml -f k8s/12-gotenberg.yaml
```

**Drop folder** — any shared filesystem the pod can mount (an NFS export works well and lets
you drop files from outside the cluster). Set the pod's `runAsUser`/`runAsGroup` to the
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

## Failure alerts

Every failure also inserts a best-effort `ingest-failure` row into `public.reports`
(migration `0007`) with the file name and error. That insert never breaks the ingest loop;
if the database itself is down it no-ops and the failure is still logged to stdout and the
file still lands in `failed/`.

`workflow.ingest-failure-alerts.json` is an n8n workflow that polls `reports` every five
minutes and emails one digest of up to 50 previously unnotified failures:

- `claim_alerts.sql` claims rows under a ten-minute lease in `report_email_delivery`, so
  overlapping polls can't send the same batch. Expired, unacknowledged sends are retried.
- Only SMTP acceptance by the configured recipient advances `sent_at`
  (`ack_alerts.sql`). A stale worker can't acknowledge a replacement lease. A crash after
  SMTP accepts but before the acknowledgement can produce a duplicate (at-least-once).
- The email carries report IDs and timestamps only: no file names, contents, or
  tracebacks.
- If the report query itself fails, a separate monitor email goes out, with a one-hour
  cooldown. If n8n or SMTP is down, nothing is delivered; keep your platform monitoring.

After import, set the SMTP and Postgres credentials and replace `alerts@example.com` in the
`Email digest` node and the `Verify SMTP acceptance` code. A report row with
`meta.synthetic = 'true'` produces a `[TEST]` subject, for end-to-end checks.

Tests:

- `node test_alert_workflow.js` checks digest, cooldown, SMTP acceptance and
  acknowledgement logic from the exported workflow.
- `python test_alerts.py` runs a real empty-file ingest, migration replay, concurrent
  claims, and retry fencing against a disposable PostgreSQL server selected by `PG*`
  variables plus `MIGRATION_TEST_DISPOSABLE=yes`.

## Notes

- Same-name collision: two different files sharing a filename collide on `source_ref`
  (the second replaces the first's rows). Fine for curated drops.
- Non-markdown extracts as flat text (Tika `text/plain`), so page/sheet/slide structure is
  lost beyond the detected headings. Switching to Tika XHTML output could recover more.
- Scanned/image-only content relies on Tika's Tesseract OCR — quality tracks the scan, and
  large scans take seconds per page.
- Tika is a JVM (~1 GB idle, more during OCR) and Gotenberg carries LibreOffice + Chromium;
  both are always-on and heavier than the ingester itself.
