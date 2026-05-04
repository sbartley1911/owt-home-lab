# Standard Notes Web — Self-Hosted

[![Standard Notes](https://img.shields.io/badge/Standard%20Notes-web%20client-086DD7)](https://github.com/standardnotes/app)
[![Docker](https://img.shields.io/badge/docker-compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)
[![Portainer](https://img.shields.io/badge/Portainer-stack-13BEF9?logo=portainer&logoColor=white)](https://www.portainer.io/)
[![License](https://img.shields.io/badge/License-AGPL--3.0-blue)](https://www.gnu.org/licenses/agpl-3.0)

Docker Compose / Portainer stack for self-hosting the **Standard Notes web
client** ([github.com/standardnotes/app](https://github.com/standardnotes/app),
`packages/web`) against your own sync server.

> **Heads-up:** This repo deploys the *web app* (frontend) only. For the
> backend you need [`standardnotes/server`](https://github.com/standardnotes/server).

---

## Table of contents

- [Why self-host the web app?](#why-self-host-the-web-app)
- [Architecture](#architecture)
- [Requirements](#requirements)
- [Quick start — Portainer](#quick-start--portainer)
- [Quick start — Docker Compose CLI](#quick-start--docker-compose-cli)
- [Configuration](#configuration)
- [The `crypto.subtle` / secure-context gotcha](#the-cryptosubtle--secure-context-gotcha)
- [Reverse proxy with HTTPS](#reverse-proxy-with-https)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [References](#references)
- [License](#license)

---

## Why self-host the web app?

The hosted web app at `app.standardnotes.com` has a Content Security Policy
that **only allows connections to Standard Notes' own domains**. If you're
running your own sync server, the hosted web app won't connect to it — you
need to self-host the frontend as well.

Desktop and mobile apps don't have this restriction and work fine against a
self-hosted sync server out of the box.

## Architecture

```
                 ┌──────────────────────────────────────┐
                 │             Your browser             │
                 └──────────────┬───────────────────────┘
                                │  https://notes.example.com
                                ▼
                 ┌──────────────────────────────────────┐
                 │      Reverse proxy (TLS termination) │
                 │           Caddy / Traefik / nginx    │
                 └──┬───────────────────────────────┬───┘
                    │                               │
        http://host:3001                  https://notesync.example.com
                    │                               │
                    ▼                               ▼
        ┌─────────────────────────┐   ┌──────────────────────────┐
        │  standardnotes/web      │   │  standardnotes/server    │
        │  (this repo)            │   │  (sync, auth, files)     │
        │  nginx :80 inside       │   │                          │
        └─────────────────────────┘   └──────────────────────────┘
```

The web container is a static-file nginx image listening on port **80**
internally; this stack maps host `3001` → container `80`.

## Requirements

- Docker Engine 20.10+ and Compose v2 (`docker compose`).
- A running Standard Notes sync server reachable over the network.
- Port `3001` free on the Docker host (override with `HOST_PORT`).
- A reverse proxy with HTTPS in front of the web app for any real use —
  see [secure-context gotcha](#the-cryptosubtle--secure-context-gotcha).

## Quick start — Portainer

1. Clone this repo or copy `docker-compose.yml` and `stack.env` to your
   machine.
2. In Portainer: **Stacks → Add stack**, name it `standardnotes-web`.
3. **Build method**: leave **Web editor** selected and paste
   `docker-compose.yml`.
4. Scroll to **Environment variables → Advanced mode** and paste
   `stack.env` — or click **Load variables from .env file** and upload it.
5. Edit `DEFAULT_SYNC_SERVER` to point at your own sync server.
6. Click **Deploy the stack**.

The web app will be reachable at `http://<docker-host-ip>:3001`.

## Quick start — Docker Compose CLI

```bash
git clone <this repo>
cd <this repo>

# Edit stack.env → set DEFAULT_SYNC_SERVER
cp stack.env .env
$EDITOR .env

docker compose up -d
```

Open `http://<docker-host-ip>:3001`.

## Configuration

All variables have defaults in the compose file via `${VAR:-default}` syntax,
so the stack starts even with an empty environment.

| Variable              | Default                                 | Purpose                              |
| --------------------- | --------------------------------------- | ------------------------------------ |
| `HOST_PORT`           | `3001`                                  | Host port the web app binds to       |
| `DEFAULT_SYNC_SERVER` | `https://sync.example.com`              | Sync server URL the client connects to |
| `DASHBOARD_URL`       | `https://standardnotes.com/dashboard`   | "Dashboard" link in the account menu |
| `PLANS_URL`           | `https://standardnotes.com/plans`       | "Plans" link                         |
| `PURCHASE_URL`        | `https://standardnotes.com/purchase`    | "Upgrade" link                       |

Variable names come from the upstream
[`.env.sample`](https://github.com/standardnotes/app/blob/main/.env.sample).

## The `crypto.subtle` / secure-context gotcha

Standard Notes does client-side end-to-end encryption using the browser's
**Web Crypto API** (`crypto.subtle`). Browsers only expose this API in a
[secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts),
which in practice means one of:

- **HTTPS** (any valid certificate)
- **`http://localhost`** or **`http://127.0.0.1`**

Plain HTTP to a LAN IP like `http://192.168.1.50:3001` does **not** qualify.
If you try to use the app over plain HTTP to a LAN IP you'll see:

```
TypeError: can't access property "digest", crypto.subtle is undefined
```

…and login/register will fail immediately.

**Solutions**, pick one:

1. Access via `http://localhost:3001` from the Docker host itself (fine for
   testing).
2. Put a reverse proxy with TLS in front of the web app — see below.
3. Use Tailscale with MagicDNS / Tailscale HTTPS, which gives you valid
   certs on a `*.ts.net` hostname.

## Reverse proxy with HTTPS

The web app and the sync server are two separate origins and each needs its
own HTTPS hostname. A typical split:

| Hostname                            | Proxies to              | Purpose      |
| ----------------------------------- | ----------------------- | ------------ |
| `https://notes.example.com`         | `http://<host>:3001`    | Web app      |
| `https://notesync.example.com`      | `http://<sync-host>:3000` | Sync server |

Your public web-app URL **does not** go in the compose file or `stack.env`.
Only `DEFAULT_SYNC_SERVER` (the API URL) does. The web app serves whatever
hostname hits the reverse proxy.

Minimal **Caddy** example:

```caddyfile
notes.example.com {
    reverse_proxy <docker-host>:3001
}

notesync.example.com {
    reverse_proxy <sync-host>:3000
}
```

Caddy handles cert provisioning automatically via Let's Encrypt. Traefik or
nginx + Certbot work equally well.

## Updating

**Portainer:** open the stack → **Editor** tab → **Update the stack** with
**Re-pull image** enabled.

**CLI:**

```bash
docker compose pull
docker compose up -d
```

For reproducible upgrades, pin the image tag in `docker-compose.yml` instead
of using `latest`:

```yaml
image: standardnotes/web:3.201.21
```

Latest tags are listed at <https://hub.docker.com/r/standardnotes/web/tags>.

## Troubleshooting

<details>
<summary><strong>Connection refused on port 3001</strong></summary>

The container listens on port **80** internally, not 3001. The compose file
handles this with a `3001:80` mapping. If you've changed the right-hand side
of the mapping, revert it. The `PORT` environment variable is **not** honored
by this image — it's a static-file nginx build.
</details>

<details>
<summary><strong><code>crypto.subtle is undefined</code></strong></summary>

You're accessing the web app from a non-secure context (HTTP to a LAN IP).
See [the secure-context gotcha](#the-cryptosubtle--secure-context-gotcha).
</details>

<details>
<summary><strong>Login/register fails with a network error</strong></summary>

The web app can't reach the sync server. Check:

- `DEFAULT_SYNC_SERVER` env var inside the container:
  `docker exec standardnotes-web env | grep SYNC`
- Sync server reachable from the Docker host:
  `curl -I <DEFAULT_SYNC_SERVER>`
- Browser DevTools → Network: confirm auth requests go to your sync URL and
  not `api.standardnotes.com`.
- If the sync URL is HTTPS but uses a self-signed cert, import the CA into
  your browser/OS trust store first.
</details>

<details>
<summary><strong>Mixed-content warnings in the console</strong></summary>

The web app is HTTPS but the sync server is HTTP (or vice versa). Browsers
block HTTPS → HTTP requests. Either put both behind HTTPS or access both
over HTTP (localhost only, because of the secure-context rule).
</details>

<details>
<summary><strong>Site loads but shows an old version after upgrade</strong></summary>

Hard-refresh: <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> (or
<kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>R</kbd> on macOS). The app is a static
SPA and the browser caches aggressively between releases.
</details>

## References

- Web app source — <https://github.com/standardnotes/app>
- Upstream env sample — <https://github.com/standardnotes/app/blob/main/.env.sample>
- Sync server stack — <https://github.com/standardnotes/server>
- Docker image — <https://hub.docker.com/r/standardnotes/web>
- Official self-hosting docs — <https://standardnotes.com/help/self-hosting/getting-started>

## License

Deployment configs in this repo are provided as-is. The Standard Notes web
app itself is licensed under [AGPL-3.0](https://www.gnu.org/licenses/agpl-3.0);
see [standardnotes/app](https://github.com/standardnotes/app) for the source
code and upstream license terms.
