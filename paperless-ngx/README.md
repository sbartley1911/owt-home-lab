# Paperless-ngx Docker Setup

A production-ready Docker Compose setup for [Paperless-ngx](https://paperlessngx.com/) with PostgreSQL, Redis, Tika, and Gotenberg.

## Architecture

- **Fast storage (Docker volumes):** PostgreSQL database, Redis cache
- **NFS storage:** Document files, media, exports, consume directory
- **Services:** Paperless webserver, Gotenberg (PDF conversion), Apache Tika (document extraction)
- **Port:** 8000 (accessible via secure tunnel)

## Prerequisites

- Docker and Docker Compose installed
- NFS mounts available at `/mnt/nfs/appdata/paperless-ngx/`
- Portainer (optional, for UI management)

## Quick Start

1. **Copy the environment template:**
   ```bash
   cp docker-compose.env.example docker-compose.env
   ```

2. **Edit secrets in `docker-compose.env`:**
   - `POSTGRES_PASSWORD` — strong database password
   - `PAPERLESS_ADMIN_PASSWORD` — strong admin password
   - `PAPERLESS_SECRET_KEY` — (optional, already set, can regenerate with `openssl rand -hex 32`)

3. **Deploy:**
   
   **Via Docker Compose:**
   ```bash
   docker compose up -d
   ```
   
   **Via Portainer:**
   - Create new Stack
   - Paste `docker-compose.yaml` content
   - Add environment variables from `docker-compose.env`
   - Deploy

4. **Access:**
   - Local: http://localhost:8000
   - Public: via secure tunnel (configure PAPERLESS_URL in docker-compose.env)
   - Admin user: configured in PAPERLESS_ADMIN_USER

## NFS Setup

Ensure these directories exist on your NFS mount:
```bash
mkdir -p /mnt/nfs/appdata/paperless-ngx/{data,media,export,consume}
chmod 1000:1000 /mnt/nfs/appdata/paperless-ngx
```

## Health Checks

All containers include health checks. Monitor with:
```bash
docker compose ps
```

Unhealthy containers will automatically restart.

## Configuration

See `docker-compose.env` for available options:
- OCR languages
- Document filename format
- Consumer polling interval
- Timezone

For full options, see [Paperless-ngx Configuration](http://docs.paperless-ngx.com/configuration/)

## Security Notes

- Secrets are stored in `docker-compose.env` (ignored by Git)
- Use strong passwords for `POSTGRES_PASSWORD` and `PAPERLESS_ADMIN_PASSWORD`
- Accessed via encrypted Pangolin tunnel
- Django `SECRET_KEY` is set for session security

## Troubleshooting

**Containers not starting:**
```bash
docker compose logs
```

**NFS permission issues:**
Ensure directories are owned by UID:GID 1000:1000 (configured in `docker-compose.env`)

**Database errors:**
Check Postgres is healthy: `docker compose ps`

## Volumes

| Service | Type | Path | Purpose |
|---------|------|------|---------|
| PostgreSQL | Docker Volume | `postgres-data` | Database |
| Redis | Docker Volume | `redis-data` | Cache/broker |
| Paperless | NFS | `/mnt/nfs/appdata/paperless-ngx/data` | Config & metadata |
| Paperless | NFS | `/mnt/nfs/appdata/paperless-ngx/media` | Documents |
| Paperless | NFS | `/mnt/nfs/appdata/paperless-ngx/export` | Exports |
| Paperless | NFS | `/mnt/nfs/appdata/paperless-ngx/consume` | Import queue |
