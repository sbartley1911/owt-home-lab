# Paperless-ngx

Document management / OCR archive with a Postgres backend, Redis broker, and
Gotenberg + Tika for Office/email conversion. Deployed via Portainer from this
Git repo.

## Architecture

| | |
|---|---|
| UI port | `${PAPERLESS_BIND_IP:-127.0.0.1}:${PAPERLESS_PORT:-8000}` (default loopback; set bind IP for LAN) |
| Network | Docker bridge `paperless-network` |
| Database | Postgres in an external cluster (CloudNativePG or equivalent), reached over TLS |
| Broker | `dhi.io/redis:8` (Docker Hardened Image) in `paperless-redis`, password required (local Docker volume) |
| OCR conversion | Gotenberg + Tika (internal only) |
| Reverse proxy | Your reverse proxy (set `PAPERLESS_URL` to the public HTTPS URL) |

### Storage split

Fast, latency-sensitive data lives on **local Docker volumes**; bulk data lives
on **NFS** (NAS `appdata` share):

| Data | Location |
|---|---|
| Postgres | External CNPG (or equivalent), barman-cloud backups to S3 |
| Redis (`paperless_broker_data`) | Local volume |
| Paperless `data` — search index + ML models (`paperless_data`) | Local volume |
| `consume` (user drop folder) | `/mnt/nfs/appdata/paperless-ngx/consume` |
| `media` (document archive) | `/mnt/nfs/appdata/paperless-ngx/media` |
| `export` | `/mnt/nfs/appdata/paperless-ngx/export` |

Postgres and the search index must **not** run on NFS (locking/fsync and
many-small-file performance).

## Naming scheme & folder structure

### Archive layout (`media/`)

`PAPERLESS_FILENAME_FORMAT` controls the path Paperless builds under `media/`
for every archived document:

```
{{ document_type }}/{{ correspondent }}/{{ created_year }}/{{ created_year }}-{{ created_month }}-{{ created_day }}_{{ title }}
```

Example: `Credit Card Statement/Example Bank Business Platinum/2026/2026-07-01_July_Statement.pdf`

This mirrors the existing manual `Category\Correspondent\Year\YYYY-MM-DD` convention used
for local financial-document sorting — category first so you can browse "all Insurance",
correspondent next so a company's history stays together, year for the yearly cutoff,
then a sortable date-prefixed filename.
`PAPERLESS_FILENAME_FORMAT_REMOVE_NONE=true` collapses the `document_type`/`correspondent`
segments to nothing (instead of literal `none/`) for documents you haven't classified yet,
so freshly-OCR'd, untriaged documents don't clutter the tree with `none/none/...` folders.

`document_type` and `correspondent` are Paperless metadata fields, not folder names you type —
set them once per correspondent/type as **matching rules** (Settings → Correspondents /
Document types → assign a match string or regex) and Paperless assigns them automatically
on future consumption. Only use the "Auto" (ML) matching algorithm once you have a reasonable
number of manually-tagged documents to learn from; exact/regex matching is more predictable
for a small, known set of correspondents.

### Consume folder (`consume/`)

`PAPERLESS_CONSUMER_SUBDIRS_AS_TAGS=true` + `PAPERLESS_CONSUMER_RECURSIVE=true` means every
subfolder a file is dropped into becomes a tag on that document. Keep this shallow — one
level of broad, stable categories — and let `document_type`/`correspondent` matching rules
do the finer sorting on the way out:

```
consume/
  Financial/
  Tax/
  Medical/
  Insurance/
  Legal/
  Home/
  Vehicle/
  Personal/
```

Drop a scanned document into `consume/Tax/` and it's tagged `Tax` immediately, before OCR
even finishes classifying correspondent/type. Avoid nesting deeper (e.g.
`consume/Financial/ExampleBank/`) — every extra path segment is another tag, and correspondent-level
detail belongs in the matching rules above, not the drop folder.

### Storage paths (per-category overrides)

If one archive layout doesn't fit everything — e.g. tax documents should group by tax year
regardless of correspondent — use Paperless's **Storage paths** feature (Settings → Storage
paths, configured in the UI/API, not an env var). Each storage path is its own
`PAPERLESS_FILENAME_FORMAT`-style template matched to documents by tag/correspondent/type,
and overrides the global format for just those documents. Example for the `Tax` tag:

```
Tax/{{ created_year }}/{{ correspondent }}-{{ title }}
```

### Changing the format later

If you change `PAPERLESS_FILENAME_FORMAT` (or a storage path) after documents already exist,
existing archived files keep their old names/paths until you run the renamer:

```bash
docker exec -it paperless-webserver python3 manage.py document_renamer
```

Never rename/move files inside `media/` by hand — Paperless tracks the last path it wrote
and will report the document as missing.

## Prerequisites

### On the Docker host

- A static bind IP for the UI (compose default `127.0.0.1`)
- Docker + Portainer agent
- NFS client (`nfs-common`) with the appdata share mounted under
  `/mnt/nfs/appdata/paperless-ngx/{consume,media,export}`

### On the NAS

- The `consume`, `media`, and `export` directories owned **UID 9000 (apps) /
  GID 0 (root)**, with the NFS export enabled.

## Deploy

### Portainer stack

| Setting | Value |
|---|---|
| Build method | Repository |
| Repository URL | `https://github.com/<you>/<private-deploy-repo>` |
| Reference | `refs/heads/main` |
| Compose path | `paperless-ngx/docker-compose.yaml` |

### Environment variables

Set these in Portainer's **Environment variables** (never commit them — see
`.env.example` for the full list). Generate the secrets fresh, e.g.
`openssl rand -base64 36`.

| Variable | Notes |
|---|---|
| `DB_PASSWORD` | **Required.** Password of role `paperless` on the database. Also held in the cluster Secret for the app role; rotate both together. |
| `PAPERLESS_DBHOST` | **Required.** Hostname or address of the Postgres service. |
| `PAPERLESS_DBPORT` | Default `5432`. |
| `PAPERLESS_DB_OPTIONS` | Default `sslmode=require`. |
| `REDIS_PASSWORD` | **Required.** Broker password. URL-safe (it is part of `PAPERLESS_REDIS`), e.g. `openssl rand -hex 24`. |
| `PAPERLESS_SECRET_KEY` | **Required.** Django session/CSRF key. |
| `PAPERLESS_ADMIN_PASSWORD` | **Required.** Initial superuser password. |
| `PAPERLESS_ADMIN_USER` | Default `admin`. |
| `PAPERLESS_ADMIN_MAIL` | Optional. |
| `PAPERLESS_URL` | Public HTTPS URL (reverse proxy). Required to avoid CSRF login errors when proxied; leave blank for LAN-only. |
| `PAPERLESS_BIND_IP` | Default `127.0.0.1`. |
| `PAPERLESS_PORT` | Default `8000`. |
| `PAPERLESS_VERSION` / `TIKA_VERSION` | Image tags. Paperless defaults to `3.4.2`, Tika to `3.3.1.0` (tested together). Pin both in Portainer too so a leftover `latest` does not override. |
| `CONSUME_PATH` / `MEDIA_PATH` / `EXPORT_PATH` | NFS bind paths (defaults under `/mnt/nfs/appdata/paperless-ngx`). |

Non-secret app settings (`USERMAP_*`, timezone, OCR language, filename format,
consumer options) are baked into the compose `environment:` block — no need to
set them per deploy.

## First login

The superuser is created **only on first start with an empty database**, using
`PAPERLESS_ADMIN_USER` / `PAPERLESS_ADMIN_PASSWORD`. Log in at
`http://127.0.0.1:8000` (or the public reverse-proxy URL).

If the account already exists, those env vars are ignored — reset the password
on the host instead:

```bash
docker exec -it paperless-webserver python3 manage.py changepassword admin
# or create a new superuser:
docker exec -it paperless-webserver python3 manage.py createsuperuser
```

## Backup & restore

The archive is split across two failure domains, and **only one of them is on
NFS**:

| Data | Where | Lost if… |
|---|---|---|
| Documents (originals + archive PDFs) | NFS `media/` | NAS is lost |
| Users, metadata, correspondents, tags, document relationships | External Postgres cluster | The cluster and its S3 backups are both lost |
| Search index + ML models | Local volume `paperless_data` | Rebuildable — not worth backing up |

Losing the DB volume therefore loses the *archive as an archive* even when every
PDF survives on NFS: no titles, no correspondents, no tags, no users. Backups
must cover the database, not just the files.

### Scheduled snapshot

`backup.sh` runs Paperless's own `document_exporter` and drops a dated zip into
the NFS export share — documents, metadata, users and tags together, in the
format `document_importer` consumes:

```bash
./backup.sh
```

Archives older than 30 days are pruned (`KEEP_DAYS` to change). Install on the
Docker host, nightly at 02:00 America/Chicago:

```cron
0 2 * * * /opt/paperless-ngx/backup.sh >> /var/log/paperless-backup.log 2>&1
```

### Database-only dump

Faster and smaller when you only need the metadata, e.g. immediately before a
config change. Pairs with whatever already protects `media/`:

```bash
kubectl -n paperless exec "$(kubectl -n paperless get cluster postgres -o jsonpath='{.status.currentPrimary}')" \
  -c postgres -- pg_dump -d paperless \
  | gzip > /mnt/nfs/appdata/paperless-ngx/export/paperless-db-$(date +%F).sql.gz
```

### Restore

From a `document_exporter` archive, into an **empty** install:

```bash
unzip paperless-backup-YYYY-MM-DD.zip -d /mnt/nfs/appdata/paperless-ngx/export/restore
docker exec -it paperless-webserver python3 manage.py document_importer ../export/restore
```

From a `pg_dump`, with the webserver and broker stopped, into an empty `paperless` database:

```bash
gunzip -c paperless-db-YYYY-MM-DD.sql.gz \
  | kubectl -n paperless exec -i "$(kubectl -n paperless get cluster postgres -o jsonpath='{.status.currentPrimary}')" \
    -c postgres -- psql -d paperless
```

The importer expects a clean database. Restoring over a populated install
conflicts on primary keys — restore into an empty `paperless` database instead.

### Before upgrading

The compose default is a pinned Paperless tag (`3.4.2`). A Portainer stack env
of `PAPERLESS_VERSION=latest` still overrides that and can cross a major
version. 2.x → 3.x applies irreversible schema migrations on start; rollback is
restore-from-backup onto a 2.20.15 image. Take both snapshots first and read
https://github.com/paperless-ngx/paperless-ngx/blob/v3.2.1/docs/migration-v3.md :

```bash
./backup.sh
kubectl -n paperless exec "$(kubectl -n paperless get cluster postgres -o jsonpath='{.status.currentPrimary}')" \
  -c postgres -- pg_dump -d paperless \
  | gzip > /mnt/nfs/appdata/paperless-ngx/export/paperless-db-$(date +%F).sql.gz
```

v3 also rebuilds the search index (Whoosh → Tantivy) on first start, drops
task history, and defaults the REST API to v10 (v9 still accepted). The
consumer poll env is `PAPERLESS_CONSUMER_POLLING_INTERVAL` (was
`PAPERLESS_CONSUMER_POLLING`). Duplicate rejection is no longer the default;
this stack sets `PAPERLESS_CONSUMER_DELETE_DUPLICATES=true` to keep the v2
behavior. If login returns 403 behind the reverse proxy, set `PAPERLESS_TRUSTED_PROXIES`.

## Caveats / notes

- **Fresh local volumes = empty install.** Moving the DB/index onto local Docker
  volumes means an old NFS-based database is not carried over. Migrate
  deliberately if you have existing data.
- **The database is external.** CloudNativePG (or equivalent) archives WAL and takes
  backups with barman-cloud to your object-storage bucket. Restrict `pg_hba` and the
  load-balancer Service to the Docker host.
- **`dhi.io/redis` runs as UID 65532** with a password. It cannot read the old `redis:8`
  volume, so it uses `paperless_broker_data`. A "Failed to write PID file" line at start
  is harmless. The host needs `docker login dhi.io` (read-only token) to pull it.
- **Gotenberg is locked down** for `.eml` conversion: JavaScript disabled and a
  `file:///tmp/.*` allow-list, so tracking pixels / scripts can't load.
- **Permissions:** Paperless runs as UID 9000, matching the NFS share owner, so
  writes to `consume`/`media`/`export` succeed. NAS `root_squash` maps UID 0
  to `nobody`, so a `docker exec` as root will appear to fail write tests — test
  as UID 9000 instead.
