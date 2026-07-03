# TrueNAS MCP Connector — Build Guide

Step-by-step instructions for building an MCP server in n8n that lets AI agents operate TrueNAS **without ever touching a credential**. Built and verified in mid-2026 against the TrueNAS SCALE 25.04/26 JSON-RPC API and n8n 2.x.

**The idea:** the agent calls a bearer-authenticated MCP endpoint; an n8n workflow fetches the TrueNAS API key from AWS Secrets Manager at runtime, speaks JSON-RPC 2.0 over WebSocket to TrueNAS, and returns results only. The agent holds one revocable caller token and nothing else. If an agent can retrieve a plaintext secret it will eventually leak it somewhere — so the fix is removing the capability, not writing a stronger prompt. n8n is deterministic: a workflow that uses a credential in one node and returns a status in the next cannot decide to also print the value.

```
Agent --(bearer)--> n8n MCP trigger --> tool node --> sub-workflow
                                                          |--> AWS SM (GetSecretValue, runtime)
                                                          |--> wss://<TRUENAS_HOST>/api/current (JSON-RPC 2.0)
```

**Prerequisites:** self-hosted n8n 2.x (this build ran on Kubernetes with queue mode: one main + workers), TrueNAS SCALE 25.04+, an AWS account for Secrets Manager, and network reachability from the n8n pods to the TrueNAS web port.

| Component | Value |
|---|---|
| MCP endpoint | `https://<your-n8n>/mcp/truenas/sse` (SSE transport) |
| Caller token | AWS SM `truenas/mcp-token` |
| TrueNAS credential | AWS SM `truenas/api-key` = `{"username":"truenas-ai","api_key":"N-..."}` |
| n8n workflows | `TrueNAS MCP` (MCP server), `TrueNAS: JSON-RPC call` (bridge), `TrueNAS: rotate API key` (rotation) |

---

## Step 0 — API facts to know before building

Verified against api.truenas.com/v26.0 docs, the truenas/middleware source, and a live `core.ping` probe:

- The only API in TrueNAS 26 is JSON-RPC 2.0 over WebSocket at `ws(s)://<host>/api/current`. REST was deprecated in 25.04 and removed in 26. The old `/websocket` path is the legacy DDP protocol — do not use it.
- Auth happens **after** connecting, in-band: `auth.login_ex` with `{"mechanism":"API_KEY_PLAIN","username":"...","api_key":"..."}`. The username is required — the key alone is not enough. (`auth.login_with_api_key` still works but is deprecated for removal in v27.)
- **TrueNAS auto-revokes any API key presented over plain HTTP.** The connector must use `wss://`. Self-signed cert is fine — disable verification client-side (same as `midclt --insecure`).
- Framing: `{"jsonrpc":"2.0","id":N,"method":"...","params":[...]}`, positional params, no batch support. Error code `-32000` = too many concurrent calls (serialize requests), `-32001` = method call error with `data.reason` detail.
- Mutating methods may return a job id (integer). `core.job_wait` is itself a job, so the reliable pattern is polling `core.get_jobs [[["id","=",<id>]]]` until state is SUCCESS/FAILED/ABORTED.

## Step 1 — TrueNAS service account

Credentials → Users → Add:

- Username `truenas-ai` (any name — just remember the API key must be created under this exact user)
- Allow Access: **TrueNAS Access only** (uncheck SMB; leave Shell/SSH off) with role **Readonly Admin**
- Authentication: **Disable Password** (API-key-only account)

Then user menu (top right) → API Keys → Add, linked to the service user, with an expiry date (the rotation workflow later takes over expiry management). The key displays once: `N-` prefix + 64 chars, ~66 chars total.

Gotcha: the key is bound to the user selected in the Add API Key form, and `auth.login_ex` needs that exact username. If login returns `AUTH_ERR` with a good key, log in with the deprecated key-only method `auth.login_with_api_key` and call `auth.me` — it reveals which user the key actually belongs to.

## Step 2 — Secrets in AWS Secrets Manager

- `truenas/api-key` — SecretString is JSON: `{"username":"truenas-ai","api_key":"N-..."}`. The Code node parses both fields.
- `truenas/mcp-token` — the caller-facing bearer for the MCP trigger. Generate with `aws secretsmanager get-random-password --password-length 48 --exclude-punctuation`; the same value goes into the n8n bearer credential.

Two-tier token design: the caller token is cheap and revocable per integration; the real API key never leaves n8n's execution memory. Handling rule used throughout the build: secret values only move machine-to-machine (file drop → variable → API call) — never pasted into a chat, terminal output, or commit.

## Step 3 — IAM user for n8n

n8n needs its own AWS identity to call Secrets Manager at runtime (a static key is the pragmatic interim; IAM Roles Anywhere is the long-term replacement for on-prem workloads). Create `n8n-secrets-reader` with one inline policy:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue", "secretsmanager:PutSecretValue"],
      "Resource": "arn:aws:secretsmanager:<REGION>:<ACCOUNT_ID>:secret:truenas/*"
    }
  ]
}
```

`PutSecretValue` exists solely for the rotation workflow. The trailing `*` is required — SM ARNs end in a random suffix. Scope grows one prefix at a time as integrations are added; no ListSecrets, no writes outside the prefix.

## Step 4 — Enable the `ws` module in the n8n Code node

n8n 2.x Code-node sandbox has **no WebSocket global and blocks `$env`** (v2 breaking change: `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` default). Module imports are gated by `NODE_FUNCTION_ALLOW_EXTERNAL`. On Kubernetes:

```
kubectl -n n8n set env deploy/n8n        NODE_FUNCTION_ALLOW_EXTERNAL=ws
kubectl -n n8n set env deploy/n8n-worker NODE_FUNCTION_ALLOW_EXTERNAL=ws
```

(Docker: add the env var to every n8n container.) This loosens the sandbox by exactly one module; crypto/https/net/tls stay blocked. Verify from inside a Code node: `require('ws')` should return a function, everything else should still throw "disallowed".

## Step 5 — n8n credentials

Created via `POST /api/v1/credentials` (n8n public API) — or the UI. Two API schema quirks: payloads are rejected unless the conditional discriminator fields are explicitly present, and (PowerShell-specific) build JSON with `[IO.File]::ReadAllText`, not `Get-Content -Raw`, or strings serialize as `{value:...}` objects.

1. **`TrueNAS MCP Bearer`** (`httpBearerAuth`): `{"token":"<bearer>","allowedHttpRequestDomains":"none"}` — domain `none` makes the credential trigger-only, unusable in outbound HTTP nodes.
2. **`AWS (n8n secrets read)`** (`aws`): `{"region":"<REGION>","accessKeyId":"...","secretAccessKey":"...","temporaryCredentials":false,"customEndpoints":false,"allowedHttpRequestDomains":"domains","allowedDomains":"secretsmanager.<REGION>.amazonaws.com"}` — locked so it can only ever sign requests to Secrets Manager.

## Step 6 — Sub-workflow: `TrueNAS: JSON-RPC call`

Three nodes, linear. This is the only place the TrueNAS key ever exists, in memory, per execution.

**Node 1 — Execute Workflow Trigger** (`In`), inputs: `method` (string), `params_json` (string), `wait_job` (string `'true'`/`'false'`). Strings keep the tool-node mapping trivial.

**Node 2 — HTTP Request** (`Get TrueNAS Secret`), executeOnce, credential = AWS (n8n secrets read):
- POST `https://secretsmanager.<REGION>.amazonaws.com/`
- Headers: `X-Amz-Target: secretsmanager.GetSecretValue`, `Content-Type: application/x-amz-json-1.1`
- Body: `{"SecretId":"truenas/api-key"}`
- Gotcha: SM answers with content-type `x-amz-json-1.1`, which the HTTP node does not auto-parse — the JSON arrives as text in `json.data`. The Code node handles both shapes.

**Node 3 — Code** (`TrueNAS JSON-RPC`), runOnceForAllItems:

```javascript
const WS = require('ws');
const TRUENAS_HOST = '<TRUENAS_HOST>';     // labeled host var — single place to update
const API_PATH = '/api/current';
const CONNECT_TIMEOUT_MS = 10000;
const CALL_TIMEOUT_MS = 45000;
const JOB_POLL_MS = 2000;
const JOB_TIMEOUT_MS = 180000;

const smResp = $('Get TrueNAS Secret').first().json;
const secretStr = smResp.SecretString || (typeof smResp.data === 'string' ? JSON.parse(smResp.data).SecretString : undefined);
if (!secretStr) throw new Error('SecretString missing from Secrets Manager response');
const secret = JSON.parse(secretStr);
const inp = $('In').first().json;
const method = String(inp.method || '');
if (!method) throw new Error('method is required');
let params = [];
if (inp.params_json) {
  try { params = JSON.parse(inp.params_json); } catch (e) { throw new Error('params_json is not valid JSON'); }
  if (!Array.isArray(params)) throw new Error('params_json must be a JSON array');
}
const waitJob = String(inp.wait_job || 'false') === 'true';

const ws = new WS('wss://' + TRUENAS_HOST + API_PATH, { rejectUnauthorized: false });
let nextId = 1;
const pending = new Map();
ws.on('message', (buf) => {
  let msg;
  try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
  if (msg.id !== undefined && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const d = msg.error.data || {};
      p.reject(new Error('RPC ' + msg.error.code + ' on ' + p.method + ': ' + (d.reason || msg.error.message || 'error')));
    } else { p.resolve(msg.result); }
  }
});
function call(m, prm, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout after ' + timeoutMs + 'ms: ' + m)); }, timeoutMs);
    pending.set(id, { resolve, reject, timer, method: m });
    ws.send(JSON.stringify({ jsonrpc: '2.0', id: id, method: m, params: prm }));
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

await new Promise((resolve, reject) => {
  const t = setTimeout(() => { reject(new Error('websocket connect timeout')); }, CONNECT_TIMEOUT_MS);
  ws.on('open', () => { clearTimeout(t); resolve(); });
  ws.on('error', (e) => { clearTimeout(t); reject(new Error('websocket error: ' + e.message)); });
});

let result;
try {
  const login = await call('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN', username: secret.username, api_key: secret.api_key }], 15000);
  if (!login || login.response_type !== 'SUCCESS') throw new Error('TrueNAS auth failed: ' + ((login && login.response_type) || 'no response'));
  result = await call(method, params, CALL_TIMEOUT_MS);
  if (waitJob && Number.isInteger(result)) {
    const jobId = result;
    const deadline = Date.now() + JOB_TIMEOUT_MS;
    let job = null;
    while (Date.now() < deadline) {
      const jobs = await call('core.get_jobs', [[['id', '=', jobId]]], 15000);
      const j = jobs && jobs[0];
      if (j && ['SUCCESS', 'FAILED', 'ABORTED'].indexOf(j.state) >= 0) { job = j; break; }
      await sleep(JOB_POLL_MS);
    }
    if (!job) throw new Error('job ' + jobId + ' did not finish within ' + JOB_TIMEOUT_MS + 'ms');
    if (job.state !== 'SUCCESS') throw new Error('job ' + jobId + ' ' + job.state + ': ' + (job.error || 'no error detail'));
    result = { job_id: jobId, state: job.state, result: job.result };
  }
} finally {
  try { ws.close(); } catch (e) {}
}
return [{ json: { method: method, result: result } }];
```

**Settings** (via `PUT /api/v1/workflows/{id}` or the UI): `saveDataSuccessExecution: "none"`, `saveDataErrorExecution: "none"`, `saveManualExecutions: false`, `saveExecutionProgress: false` — the fetched key never persists in execution history.

**Activate the sub-workflow.** Production (trigger-initiated) executions fail with "Workflow is not active" if a called sub-workflow is inactive.

## Step 7 — MCP server workflow: `TrueNAS MCP`

One `@n8n/n8n-nodes-langchain.mcpTrigger` node (v1.1): path `truenas`, authentication `bearerAuth`, credential `TrueNAS MCP Bearer`. v1.1 serves **SSE transport**: clients connect to `/mcp/truenas/sse`, receive a per-session `messages` URL, and POST JSON-RPC there.

Each tool is a `@n8n/n8n-nodes-langchain.toolWorkflow` node (v2.2) connected to the trigger via an `ai_tool` connection. The node name is the tool name. Parameters: `description`, `workflowId` = the sub-workflow (mode `id`), and `workflowInputs` with `mappingMode: defineBelow` mapping the three inputs. Fixed tools hardcode the mapping; agent-parameterized tools use `$fromAI()` expressions.

Read-only tools (build these first to validate the path):

| Tool | method | params_json |
|---|---|---|
| list_pools | `pool.query` | `[]` |
| list_datasets | `pool.dataset.query` | `[[],{"select":["id","name","pool","type","used","available","mountpoint"]}]` |
| list_snapshots | `pool.snapshot.query` | `[[],{"select":["id","dataset","snapshot_name"],"limit":500}]` |
| list_replication_tasks | `replication.query` | `[]` |
| list_vms | `vm.query` | `[]` |
| list_apps | `app.query` | `[]` |
| list_disks | `disk.query` | `[]` |
| list_alerts | `alert.list` | `[]` |
| get_recent_jobs | `core.get_jobs` | `[[],{"order_by":["-id"],"limit":20}]` |

Write tools (add after the read path is proven), all with `wait_job: 'true'` (harmless for synchronous methods, correct for jobs):

| Tool | method | params_json mapping |
|---|---|---|
| start_vm | `vm.start` | `={{ JSON.stringify([$fromAI('vm_id', 'numeric id of the VM to start', 'number')]) }}` |
| stop_vm | `vm.stop` | same shape with stop wording |
| create_snapshot | `pool.snapshot.create` | `={{ JSON.stringify([{ dataset: $fromAI('dataset', '...', 'string'), name: $fromAI('snapshot_name', '...', 'string') }]) }}` |
| create_dataset | `pool.dataset.create` | `={{ JSON.stringify([{ name: $fromAI('name', 'full dataset path', 'string') }]) }}` |

Publish (activate) the workflow — the endpoint only exists while active.

## Step 8 — Write roles on the service account

Deliberate scope decision: only reversible operations. **No delete roles are granted anywhere**, so data destruction is impossible for this connector regardless of caller behavior — the guarantee lives in TrueNAS RBAC, not in prompts. (If you do add destructive tools later, put them behind a separate MCP endpoint with its own bearer and a path allowlist enforced in the Code node.)

1. Credentials → Groups → Add: local group `n8n-writes`; add the service user to it.
2. Privileges screen (`/ui/credentials/groups/privileges`) → Add: name `n8n-writes`, Local Group `n8n-writes`, Roles `VM_WRITE`, `SNAPSHOT_WRITE`, `DATASET_WRITE`. No web shell.

Roles apply on next login — the connector logs in per call, so no restart. Verify with `auth.me` (roles come back as `{"$set":[...]}`).

## Step 9 — Rotation workflow: `TrueNAS: rotate API key`

Monthly schedule. Ordering is the whole design: **create the replacement first, store it, verify the stored copy, and only then delete old keys.** A failure at any step leaves a working key in SM; strays from failed runs are swept by the next successful run (every key except the new one is deleted after verification). AWS-native rotation (Lambda) can't reach a LAN-only TrueNAS or an internal-only n8n — so n8n rotates its own credential.

Nodes: Schedule Trigger → `Get Current Secret` (same SM GET as step 6) → `Rotate: create new key` (Code) → `Store New Key` (HTTP) → `Read Back Secret` (SM GET again) → `Verify and delete old` (Code).

The two Code nodes reuse the WebSocket boilerplate from step 6. The distinct logic:

```javascript
// Rotate: create new key — after login with the current key:
const existing = await call('api_key.query', [[['username', '=', secret.username]]], 15000);
const oldIds = existing.map((k) => k.id);
const expiresMs = Date.now() + 60 * 24 * 3600 * 1000;
const newName = secret.username + '-' + new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const created = await call('api_key.create', [{ name: newName, username: secret.username, expires_at: { '$date': expiresMs } }], 30000);
// output: secret_json (new {username,api_key} JSON), old_ids, new_key_id, client_token (random string)
```

`Store New Key` HTTP body (expression): `={{ JSON.stringify({ SecretId: 'truenas/api-key', SecretString: $json.secret_json, ClientRequestToken: $json.client_token }) }}`

```javascript
// Verify and delete old — log in with the READ-BACK value; only on SUCCESS:
for (const id of (rot.old_ids || [])) {
  if (id === rot.new_key_id) continue;
  await call('api_key.delete', [id], 15000);
}
```

Hard-won specifics:

- `expires_at` must be **`{"$date": epoch_ms}`** — every ISO-8601 string form is rejected despite the docs saying ISO 8601.
- Raw `PutSecretValue` calls **require `ClientRequestToken`** (SDKs normally generate it silently).
- `api_key.create` names must be unique — use second-precision timestamps.
- Readonly Admin **can** self-manage its own API keys (`api_key.create` docs: role `API_KEY_WRITE | READONLY_ADMIN`), so rotation needs no extra privileges.
- Same hardened settings as step 6 (no execution data saved), and activate the workflow.

Because the connector re-fetches the secret every execution, rotation takes effect instantly. The rolling 60-day expiry is the dead-man backstop; wire failed runs into whatever n8n error alerting you have.

## Step 10 — Verification procedure

1. `core.ping` over the WebSocket → `"pong"` (unauthenticated; proves endpoint/protocol).
2. Auth enforcement on the MCP endpoint: GET `/mcp/truenas/sse` without bearer → 403; with bearer → 200 + `event: endpoint`.
3. Full MCP round-trip: hold the SSE stream open, POST `initialize` → `notifications/initialized` → `tools/list` → `tools/call` to the per-session messages URL (all return 202; results arrive as SSE `message` events).
4. `list_pools` end-to-end → real pool data, then grep the entire SSE stream for `api_key`/`SecretString` → must be zero hits.
5. Write tools: `create_snapshot`/`create_dataset` on a scratch path (e.g. `tank/n8n-scratch`), delete the artifacts afterward in the UI. VM tools can be validated with a nonexistent id — a "VM 999999 does not exist" error proves the role check passed and the method executed, with zero state change.
6. One real rotation run, then confirm: SM version changed, stored key logs in, exactly one key remains on the user, connector still green.

## Consuming the endpoint

MCP client config: SSE transport, URL `https://<your-n8n>/mcp/truenas/sse`, header `Authorization: Bearer <value of truenas/mcp-token>`. Keep it internal — don't expose the n8n MCP path publicly.

## Gotcha index

| Gotcha | Consequence if missed |
|---|---|
| `ws://` (plain HTTP) with an API key | TrueNAS **revokes the key on first login attempt** |
| No username in `auth.login_ex` | `AUTH_ERR` even with a valid key |
| Key created under the wrong user | `AUTH_ERR`; identify owner via `auth.login_with_api_key` + `auth.me` |
| n8n v2 Code sandbox | No WebSocket global, `$env` blocked — needs `NODE_FUNCTION_ALLOW_EXTERNAL=ws` |
| SM responses are `x-amz-json-1.1` | HTTP node leaves JSON as text in `json.data` |
| `expires_at` as ISO string | `EINVAL` — must be `{"$date": epoch_ms}` |
| Raw `PutSecretValue` without `ClientRequestToken` | 400 |
| Inactive sub-workflow | Production tool calls fail: "Workflow is not active" |
| `core.job_wait` | Is itself a job — poll `core.get_jobs` instead |
| Execution data saving left on | Fetched key persists in run history — set all saving off on secret-path workflows |
