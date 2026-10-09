#!/usr/bin/env python3
"""OpenBrain consume-folder ingester.

Polls an NFS drop folder, extracts text (markdown/txt read locally; everything
else — PDF, Office, images, with OCR — via Apache Tika, falling back to Gotenberg
for odd Office files), chunks it (markdown by # headings; everything else by
detected section headings — chapter/numbered/ALL-CAPS lines — with per-chunk
first-line titles when a document has no detectable structure), embeds each
chunk with OpenAI (batched), and writes to openbrain.brain_entries. Files move
inbox -> work (claim) -> archive on success, or -> failed on error. Archive is
purged after ARCHIVE_RETAIN_DAYS.

Re-ingest is fully idempotent: chunks upsert on (source='consume',
source_ref='<file>#<idx>'), and after the write loop any chunk of the same
file carrying a different sha256 (i.e. not written by this run) is deleted in
the same transaction — so a re-dropped document that chunks SHORTER no longer
strands stale trailing chunks.
"""
import glob
import hashlib
import json
import os
import re
import time
import traceback
import urllib.request
import urllib.error

import psycopg

BASE = os.environ.get("CONSUME_DIR", "/data/consume")
INBOX = os.path.join(BASE, "inbox")
WORK = os.path.join(BASE, "work")
ARCHIVE = os.path.join(BASE, "archive")
FAILED = os.path.join(BASE, "failed")

POLL = int(os.environ.get("POLL_SECONDS", "10"))
SETTLE = int(os.environ.get("SETTLE_SECONDS", "5"))
RETAIN_DAYS = int(os.environ.get("ARCHIVE_RETAIN_DAYS", "30"))
MODEL = os.environ.get("EMBED_MODEL", "text-embedding-3-small")
# Sizing per common RAG guidance for retrieval quality (200-300 tokens/chunk):
# pack paragraphs to ~TARGET, never exceed MAX. The old MAX=6000 pinned the
# median chunk at 5.7k chars (~1400 tokens, 5x oversized).
MIN_CHARS = 400             # sections smaller than this merge into the next one
TARGET_CHARS = 1100         # ~275 tokens: aim point for paragraph packing
MAX_CHARS = 2400            # hard ceiling; also keeps embeds far under 8191 tokens
OFFICE_EXTS = (".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
               ".odt", ".ods", ".odp", ".rtf")
EXTS = (".md", ".markdown", ".txt", ".pdf", ".html", ".htm", ".csv",
        ".png", ".jpg", ".jpeg", ".tiff", ".tif", ".bmp", ".gif", ".webp") + OFFICE_EXTS

DB_URL = os.environ["DATABASE_URL"]
OPENAI_KEY = os.environ["OPENAI_API_KEY"]
TIKA_URL = os.environ.get("TIKA_URL", "http://tika:9998")
GOTENBERG_URL = os.environ.get("GOTENBERG_URL", "http://gotenberg:3000")


def log(*a):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), *a, flush=True)


def ensure_dirs():
    for d in (INBOX, WORK, ARCHIVE, FAILED):
        os.makedirs(d, exist_ok=True)


def first_line_title(text):
    """Content-derived title: the chunk's own first non-empty line, trimmed."""
    line = next((l.strip() for l in text.splitlines() if l.strip()), "(empty)")
    return line[:77] + "…" if len(line) > 78 else line


def pack_section(heading, body):
    """Pack one section's paragraphs into chunks near TARGET_CHARS.

    Returns [{'heading','text'}]. With a real heading, parts are numbered so
    every title stays distinct; with no heading (heading is None), each chunk
    titles itself by its first line — never a shared placeholder. The old
    chunker's '(preamble)' constant put ONE title on thousands of chunks and, because
    titles are prepended to the embedded text, dragged their vectors toward a
    shared meaningless centroid.
    """
    pieces, acc = [], ""
    for p in re.split(r"\n\n+", body):
        if acc and len(acc) + len(p) > TARGET_CHARS:
            pieces.append(acc.strip())
            acc = ""
        acc += p + "\n\n"
    if acc.strip():
        pieces.append(acc.strip())
    # Backstop for text without blank-line breaks (spreadsheets, flat CSV dumps):
    # hard-slice anything still over MAX so the embed call can never 400.
    sliced = []
    for t in pieces:
        if len(t) <= MAX_CHARS:
            sliced.append(t)
        else:
            sliced.extend(t[i:i + MAX_CHARS] for i in range(0, len(t), MAX_CHARS))
    out = []
    for n, t in enumerate(sliced, 1):
        if heading:
            h = heading if len(sliced) == 1 else f"{heading} (part {n})"
        else:
            h = first_line_title(t)
        out.append({"heading": h, "text": t})
    return out


def merge_tiny(sections):
    """Merge sections shorter than MIN_CHARS into the following one."""
    merged, carry = [], None
    for i, (head, body) in enumerate(sections):
        if carry:
            c_head, c_body = carry
            head = f"{c_head} / {head}" if c_head and head else (c_head or head)
            body = c_body + "\n\n" + body
            carry = None
        if len(body.strip()) < MIN_CHARS and i != len(sections) - 1:
            carry = (head, body)
            continue
        merged.append((head, body))
    if carry:
        merged.append(carry)
    return merged


def chunk_markdown(text):
    """Chunk real markdown (.md/.markdown) by its # headings."""
    sections, cur_head, cur = [], None, []
    for line in text.splitlines():
        m = re.match(r"^(#{1,6})\s+(.+)$", line)
        if m:
            if "\n".join(cur).strip():
                sections.append((cur_head, "\n".join(cur)))
            cur_head, cur = m.group(2).strip(), [line]
        else:
            cur.append(line)
    if "\n".join(cur).strip():
        sections.append((cur_head, "\n".join(cur)))
    if not sections:
        sections = [(None, text)]
    chunks = []
    for head, body in merge_tiny(sections):
        chunks.extend(pack_section(head, body.strip()))
    return chunks


# Conservative section-heading detection for flat text (Tika output from PDFs,
# plain .txt). Deliberately narrow: the old chunker treated ANY '# foo' line as
# a heading, which promoted shell comments inside code blocks to document
# titles (one shell comment titled ~100 chunks of a firewall manual). Over-matching is the failure mode to avoid; a missed
# heading just costs a first-line title, a false heading poisons a title run.
PLAIN_HEADING_RES = (
    # CHAPTER FOURTEEN / APPENDIX B / PART IV / SECTION 3
    re.compile(r"^(?:CHAPTER|APPENDIX|PART|SECTION)\s+[A-Z0-9IVXLCDM]+\s*$", re.IGNORECASE),
    # 14.1 Managing Firewall Rules / 18.9.2. OpenSSL Configuration
    re.compile(r"^\d+(?:\.\d+)+\.?\s+[A-Z][^\n]{2,68}$"),
    # short ALL-CAPS line: FIREWALL / SSL SERVER FILE USAGE
    re.compile(r"^[A-Z][A-Z0-9 ,&/()'-]{3,59}$"),
)


def chunk_plain(text):
    """Chunk flat text by detected section headings; first-line titles otherwise.

    Two guards, both added after a corpus re-ingest exposed their absence:
    - An ALL-CAPS candidate (rule 3) counts only if the next non-empty line
      reads like prose (capital + lowercase). Kills SQL/code output masquerading
      as sections — a database manual's example blocks made 'QUERY PLAN',
      'SELECT', 'DECLARE' into 25-chunk title runs.
    - A heading text already used in this document gets a continuation index
      ('SECTION 7 (cont. 2)'). Kills running page-headers repeating one title
      across ~90 chunks of a standards handbook.
    """
    lines = text.splitlines()
    stripped = [l.strip() for l in lines]

    def prose_follows(idx):
        for nxt in stripped[idx + 1:idx + 6]:
            if nxt:
                return re.match(r"^[A-Z][a-z]", nxt) is not None
        return False

    sections, cur_head, cur = [], None, []
    seen = {}
    for i, line in enumerate(lines):
        s = stripped[i]
        is_head = False
        if s and len(s) <= 72:
            if PLAIN_HEADING_RES[0].match(s) or PLAIN_HEADING_RES[1].match(s):
                is_head = True
            elif PLAIN_HEADING_RES[2].match(s) and prose_follows(i):
                is_head = True
        if is_head:
            if "\n".join(cur).strip():
                sections.append((cur_head, "\n".join(cur)))
            n = seen.get(s, 0) + 1
            seen[s] = n
            cur_head, cur = (s if n == 1 else f"{s} (cont. {n})"), []
        else:
            cur.append(line)
    if "\n".join(cur).strip():
        sections.append((cur_head, "\n".join(cur)))
    if not sections:
        sections = [(None, text)]
    chunks = []
    for head, body in merge_tiny(sections):
        chunks.extend(pack_section(head, body.strip()))
    return chunks


def embed_batch(texts, batch_size=32):
    """Embed a list of chunks in batched API calls (one call per 32 chunks).

    The corpus re-ingest embeds tens of thousands of chunks; per-chunk calls
    made large documents take hours. Falls back to per-item embed() (which
    halves oversized input) if a batch 400s.
    """
    out = []
    for i in range(0, len(texts), batch_size):
        batch = texts[i:i + batch_size]
        last = None
        for attempt in range(4):
            body = json.dumps({"model": MODEL, "input": batch}).encode()
            req = urllib.request.Request(
                "https://api.openai.com/v1/embeddings",
                data=body,
                headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = json.loads(r.read())["data"]
                    data.sort(key=lambda d: d["index"])
                    out.extend(d["embedding"] for d in data)
                    last = None
                    break
            except urllib.error.HTTPError as e:
                last = e
                if e.code == 400:
                    out.extend(embed(t) for t in batch)  # isolate the offender per-item
                    last = None
                    break
                if e.code in (429, 500, 502, 503):
                    time.sleep(2 * (attempt + 1))
                    continue
                raise
            except urllib.error.URLError as e:
                last = e
                time.sleep(2 * (attempt + 1))
        if last:
            raise last
    return out


def embed(text):
    last = None
    for attempt in range(4):
        body = json.dumps({"model": MODEL, "input": text}).encode()
        req = urllib.request.Request(
            "https://api.openai.com/v1/embeddings",
            data=body,
            headers={"Authorization": f"Bearer {OPENAI_KEY}", "Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read())["data"][0]["embedding"]
        except urllib.error.HTTPError as e:
            last = e
            if e.code == 400 and len(text) > 2000:
                text = text[: len(text) // 2]  # too many tokens → halve and retry
                continue
            if e.code in (429, 500, 502, 503):
                time.sleep(2 * (attempt + 1))
                continue
            raise
        except urllib.error.URLError as e:
            last = e
            time.sleep(2 * (attempt + 1))
    raise last


def tika_extract(data, content_type=None):
    import requests

    headers = {"Accept": "text/plain", "X-Tika-PDFOcrStrategy": "auto"}
    if content_type:
        headers["Content-Type"] = content_type
    last = None
    for attempt in range(3):
        try:
            r = requests.put(f"{TIKA_URL}/tika", data=data, headers=headers, timeout=600)
            if r.status_code >= 400:
                log("tika-http", r.status_code, "sent-bytes", len(data), "body", repr(r.text[:200]))
            # Tika can transiently 4xx/5xx under batch load or JVM warmup (observed:
            # ZeroByteFileException on a valid file when a batch floods a cold server);
            # back off and retry before giving up on the file.
            if r.status_code >= 400 and attempt < 2:
                last = requests.HTTPError(f"Tika {r.status_code}")
                time.sleep(3 * (attempt + 1))
                continue
            r.raise_for_status()
            # Tika replies text/plain WITHOUT a charset, so requests falls back
            # to ISO-8859-1 (RFC 2616) and decodes Tika's UTF-8 bytes as latin-1
            # — '®' became 'Â®' in a large share of stored chunks. Tika's
            # output is UTF-8; say so before touching r.text.
            r.encoding = "utf-8"
            return r.text
        except requests.RequestException as e:
            last = e
            time.sleep(3 * (attempt + 1))
    raise last


def gotenberg_to_pdf(data, filename):
    import requests

    r = requests.post(
        f"{GOTENBERG_URL}/forms/libreoffice/convert",
        files={"files": (filename, data)},
        timeout=300,
    )
    r.raise_for_status()
    return r.content


def extract_text(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in (".md", ".markdown", ".txt"):
        # Read markdown/text locally so heading-based chunking keeps its structure.
        # utf-8-sig strips a leading BOM (Windows-origin files).
        with open(path, "r", encoding="utf-8-sig", errors="replace") as f:
            return f.read()
    with open(path, "rb") as f:
        data = f.read()
    # Tika handles PDF, Office, images, HTML, etc. + OCR (auto strategy) on-cluster.
    text = tika_extract(data)
    if text.strip():
        return text
    # Fallback: an unusual/malformed Office file Tika couldn't read → convert to
    # PDF via LibreOffice (Gotenberg), then extract (and OCR) through Tika.
    if ext in OFFICE_EXTS:
        text = tika_extract(gotenberg_to_pdf(data, os.path.basename(path)), "application/pdf")
    return text


def process_file(path, conn):
    fname = os.path.basename(path)
    ext = os.path.splitext(path)[1].lower()
    text = extract_text(path).replace("\x00", "")  # Postgres text/tsvector reject NUL bytes
    if not text.strip():
        raise ValueError("no extractable text (empty, or scanned/image-only PDF needing OCR)")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    # Only real markdown gets the #-heading chunker; Tika's flat text goes
    # through conservative section detection instead.
    chunks = chunk_markdown(text) if ext in (".md", ".markdown") else chunk_plain(text)
    contents = [f"{fname} — {c['heading']}\n\n{c['text']}" for c in chunks]
    vecs = embed_batch(contents)
    with conn.cursor() as cur:
        for i, (c, content, vec) in enumerate(zip(chunks, contents, vecs)):
            veclit = "[" + ",".join(repr(x) for x in vec) + "]"
            meta = json.dumps({
                "file": fname, "heading": c["heading"], "sha256": digest,
                "chunk_index": i, "chunk_count": len(chunks),
            })
            cur.execute(
                """insert into brain_entries (content, embedding, source, source_ref, metadata, entry_type)
                   values (%s, %s::vector, 'consume', %s, %s::jsonb, 'document')
                   on conflict on constraint brain_entries_source_unique
                   do update set content = excluded.content,
                                 embedding = excluded.embedding,
                                 metadata = excluded.metadata""",
                (content, veclit, f"{fname}#{i}", meta),
            )
        # Every chunk written this run carries this run's sha256; anything for
        # the same file with a different digest is a stale leftover from an
        # earlier version (shrinking re-ingest orphans). Same
        # transaction as the inserts, so a failure rolls back the whole swap.
        cur.execute(
            """delete from brain_entries
               where source = 'consume'
                 and metadata->>'file' = %s
                 and metadata->>'sha256' <> %s""",
            (fname, digest),
        )
        orphans = cur.rowcount
    conn.commit()
    if orphans:
        log("orphans-removed", fname, orphans)
    return len(chunks)


def recover_work():
    # Move files stranded in work/ by a crash or restart mid-processing back to
    # inbox/ so they get retried (the main loop only scans inbox/).
    for p in glob.glob(os.path.join(WORK, "*")):
        try:
            os.replace(p, os.path.join(INBOX, os.path.basename(p)))
            log("recovered-from-work", os.path.basename(p))
        except OSError as e:
            log("recover-error", p, repr(e))


def purge_archive():
    cutoff = time.time() - RETAIN_DAYS * 86400
    for p in glob.glob(os.path.join(ARCHIVE, "*")):
        try:
            if os.path.isfile(p) and os.path.getmtime(p) < cutoff:
                os.remove(p)
                log("purged", os.path.basename(p))
        except OSError as e:
            log("purge-error", p, repr(e))


def report_failure(conn, fname, err_repr, tb):
    """Best-effort alert row: ingest failures land in reports so a dashboard
    or alert workflow can surface them. Must never break the ingest loop; if the
    DB itself is down this quietly no-ops (the failure still logs to stdout
    and the file still lands in failed/)."""
    try:
        if conn.closed:
            conn = psycopg.connect(DB_URL)
        meta = json.dumps({
            "file": fname, "error": err_repr[:1000], "component": "openbrain-consume",
        })
        with conn.cursor() as cur:
            cur.execute(
                """insert into reports (report_type, title, body_md, meta)
                   values (%s, %s, %s, %s::jsonb)""",
                ("ingest-failure", f"Consume ingest failed: {fname}",
                 f"```\n{tb[:4000]}\n```", meta),
            )
        conn.commit()
    except Exception as e:
        log("report-failure-error", repr(e))


def main():
    ensure_dirs()
    recover_work()
    log(f"consume ingester up; dir={BASE} poll={POLL}s settle={SETTLE}s retain={RETAIN_DAYS}d model={MODEL}")
    conn = psycopg.connect(DB_URL)
    last_purge = 0.0
    while True:
        try:
            if conn.closed:
                conn = psycopg.connect(DB_URL)
            now = time.time()
            for path in sorted(glob.glob(os.path.join(INBOX, "*"))):
                if not os.path.isfile(path) or not path.lower().endswith(EXTS):
                    continue
                if now - os.path.getmtime(path) < SETTLE:
                    continue  # still being written
                fname = os.path.basename(path)
                work = os.path.join(WORK, fname)
                try:
                    os.rename(path, work)  # atomic claim
                except OSError as e:
                    log("claim-failed", fname, repr(e))
                    continue
                try:
                    n = process_file(work, conn)
                    dest = os.path.join(ARCHIVE, fname)
                    os.replace(work, dest)
                    # Stamp archive mtime = now so the retention purge measures
                    # time-since-archived. SMB-copied files keep their original
                    # (often old) mtime, which would otherwise purge a backlog of
                    # existing documents immediately.
                    os.utime(dest, None)
                    log("ingested", fname, f"({n} chunks)")
                except Exception as e:
                    try:
                        conn.rollback()
                    except Exception:
                        pass
                    try:
                        os.replace(work, os.path.join(FAILED, fname))
                    except OSError:
                        pass
                    log("FAILED", fname, repr(e), "|", " ".join(traceback.format_exc().split()))
                    report_failure(conn, fname, repr(e), " ".join(traceback.format_exc().split()))
            if now - last_purge > 3600:
                purge_archive()
                last_purge = now
        except Exception as e:
            log("loop-error", repr(e))
            try:
                conn.rollback()
            except Exception:
                pass
        time.sleep(POLL)


if __name__ == "__main__":
    main()
