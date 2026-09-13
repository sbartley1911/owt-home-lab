# Direct TrueNAS NFS management

This client talks directly to the TrueNAS JSON-RPC API. It does not call n8n or
require an MCP login. The workstation needs LAN/NetBird reachability to TrueNAS,
AWS CLI access to its Secrets Manager credentials, Node.js
20.18.1 or newer, and pnpm. Install the dependency before an outage.

Set the following non-secret connection settings in the invoking process.
Keep the actual deployment settings in your private configuration record, not in
this public repository. For the Owtworth deployment, retrieve them from OpenBrain
with `OWT-99 direct TrueNAS JSON-RPC management verified`.

| Environment variable | Meaning |
| --- | --- |
| `TRUENAS_HOST` | Verified appliance hostname or IPv4 address |
| `TRUENAS_CERT_SHA256` | Verified uppercase colon-separated certificate SHA-256 fingerprint |
| `TRUENAS_READ_SECRET` | Secrets Manager identifier for the read account |
| `TRUENAS_ADMIN_SECRET` | Secrets Manager identifier for the NFS update account |
| `AWS_REGION` | Secrets Manager region; defaults to `us-east-2` |

```powershell
pnpm install --frozen-lockfile --ignore-scripts
node client.cjs status
node client.cjs nfs-list
node client.cjs nfs-update SHARE_ID patch.json
```

`patch.json` is a JSON object containing only the NFS fields you intend to change.
For example, `{"comment":"movies"}` changes the description. Inspect the current
share with `nfs-list` first and preserve its original values for rollback. The
update command returns the original share, requested patch, and the read-back
share. It does not automatically retry a failed or timed-out write; inspect the
current state before deciding whether to retry.

Reads use `TRUENAS_READ_SECRET`; updates use `TRUENAS_ADMIN_SECRET`. Both secrets
contain `username` and `api_key`. The client fetches the selected secret for each
invocation, captures it in process, and never prints it or raw login responses.
No key is saved locally. Existing TrueNAS account roles remain the authorization
boundary; this client does not grant privileges or rotate credentials.

The connection is `wss://<TRUENAS_HOST>/api/current`. The client verifies the
configured SHA-256 certificate fingerprint before sending authentication,
including when the appliance uses a self-signed certificate. On certificate
renewal, independently verify the replacement through a
trusted appliance/management path before updating the pin. Do not disable the
pin to get around a mismatch. Establish initial trust through a trusted appliance
or management path; a certificate fingerprint observed on an untrusted network
does not authenticate the server.

Scope is status and NFS query/update. It creates no new service, network listener,
account, role, or credential. The existing n8n connectors are separate entry
points. Credential rotation still uses the existing setup; this fallback does
not redesign rotation or remove AWS/network dependencies.

Work and live verification are recorded in OpenEngine OWT-99.
Retrieve the current findings from OpenBrain
with `OWT-99 direct TrueNAS JSON-RPC management verified`. Keep operational
history in OpenBrain/OpenEngine rather than this directory.

API reference: [TrueNAS 25.10 authentication](https://api.truenas.com/v25.10.0/api_methods_auth.login_ex.html)
and [NFS update](https://api.truenas.com/v25.10.0/api_methods_sharing.nfs.update.html).
