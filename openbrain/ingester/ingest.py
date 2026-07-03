#!/usr/bin/env python3
"""OpenBrain consume-folder ingester.

Polls an NFS drop folder, extracts text (markdown/txt read locally; everything
else — PDF, Office, images, with OCR — via Apache Tika, falling back to Gotenberg
for odd Office files), chunks by heading (or by size for non-markdown), embeds
each chunk with OpenAI, and upserts into openbrain.brain_entries. Files move
inbox -> work (claim) -> archive on success, or -> failed on error. Archive is
purged after ARCHIVE_RETAIN_DAYS. Idempotent per (source='consume',
source_ref='<file>#<idx>') so re-dropping an edited file refreshes its chunks.
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
MIN_CHARS = 400
MAX_CHARS = 6000            # keep chunks well under the 8191-token embedding limit
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


def chunk_markdown(text):
    sections = []
    cur = {"heading": "(preamble)", "body": []}
    for line in text.splitlines():
        m = re.match(r"^(#{1,6})\s+(.+)$", line)
        if m:
            if "\n".join(cur["body"]).strip():
                sections.append(cur)
            cur = {"heading": m.group(2).strip(), "body": [line]}
        else:
            cur["body"].append(line)
    if "\n".join(cur["body"]).strip():
        sections.append(cur)
    if not sections:
        sections = [{"heading": "(whole file)", "body": [text]}]

    # merge tiny sections into the following one
    merged, carry = [], None
    for i, s in enumerate(sections):
        if carry:
            s["body"] = ["\n".join(carry["body"])] + s["body"]
            s["heading"] = carry["heading"] + " / " + s["heading"]
            carry = None
        body = "\n".join(s["body"]).strip()
        if len(body) < MIN_CHARS and i != len(sections) - 1:
            carry = s
            continue
        merged.append(s)
    if carry:
        merged.append(carry)

    # hard-split oversized sections at paragraph boundaries
    chunks = []
    for s in merged:
        body = "\n".join(s["body"]).strip()
        if len(body) <= MAX_CHARS:
            chunks.append({"heading": s["heading"], "text": body})
            continue
        acc, part = "", 1
        for p in re.split(r"\n\n+", body):
            if acc and len(acc) + len(p) > MAX_CHARS:
                chunks.append({"heading": f"{s['heading']} (part {part})", "text": acc.strip()})
                part += 1
                acc = ""
            acc += p + "\n\n"
        if acc.strip():
            h = s["heading"] + (f" (part {part})" if part > 1 else "")
            chunks.append({"heading": h, "text": acc.strip()})
    # Guarantee no chunk exceeds MAX_CHARS. Tika's flat text for spreadsheets/CSVs
    # often lacks blank-line paragraph breaks, so the paragraph split above can leave
    # one huge chunk; hard-slice by characters as a final backstop (otherwise the
    # embed call exceeds the model's token limit and returns 400).
    final = []
    for c in chunks:
        t = c["text"]
        if len(t) <= MAX_CHARS:
            final.append(c)
            continue
        for i in range(0, len(t), MAX_CHARS):
            final.append({"heading": c["heading"] + (f" (chars {i})" if i else ""),
                          "text": t[i:i + MAX_CHARS]})
    return final


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
    text = extract_text(path).replace("\x00", "")  # Postgres text/tsvector reject NUL bytes
    if not text.strip():
        raise ValueError("no extractable text (empty, or scanned/image-only PDF needing OCR)")
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    chunks = chunk_markdown(text)
    with conn.cursor() as cur:
        for i, c in enumerate(chunks):
            content = f"{fname} — {c['heading']}\n\n{c['text']}"
            vec = embed(content)
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
    conn.commit()
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
