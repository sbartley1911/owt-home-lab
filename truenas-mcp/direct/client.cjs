const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const tls = require('node:tls');
const { Agent, WebSocket } = require('undici');

const HOST = process.env.TRUENAS_HOST;
const PIN = process.env.TRUENAS_CERT_SHA256;

async function connect(admin = false) {
  const secretId = process.env[admin ? 'TRUENAS_ADMIN_SECRET' : 'TRUENAS_READ_SECRET'];
  if (!HOST || !/^[a-zA-Z0-9.-]+$/.test(HOST)) throw new Error('Set TRUENAS_HOST to the verified appliance hostname or IPv4 address');
  if (!PIN || !/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/.test(PIN)) throw new Error('Set TRUENAS_CERT_SHA256 to the verified uppercase colon-separated SHA-256 fingerprint');
  if (!secretId) throw new Error('Set the selected TRUENAS_READ_SECRET or TRUENAS_ADMIN_SECRET identifier');
  let credential;
  try {
    // Capture stdout; never include CLI stderr or credential contents in errors.
    const raw = execFileSync('aws', ['secretsmanager', 'get-secret-value', '--region', process.env.AWS_REGION || 'us-east-2',
      '--secret-id', secretId,
      '--query', 'SecretString', '--output', 'text'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20000 });
    credential = JSON.parse(raw);
    if (!credential.username || !credential.api_key) throw new Error();
  } catch { throw new Error('Cannot load TrueNAS credential from Secrets Manager'); }

  const dispatcher = new Agent({ connect(options, callback) {
    let finished = false;
    const finish = (error, socket) => {
      if (finished) return;
      finished = true;
      callback(error, socket);
    };
    // The appliance uses a self-signed localhost certificate. Verify its pinned
    // SHA-256 fingerprint before allowing WebSocket traffic or authentication.
    const socket = tls.connect({ host: HOST, port: 443, rejectUnauthorized: false }, () => {
      socket.setTimeout(0);
      if (socket.getPeerCertificate().fingerprint256 !== PIN) {
        socket.destroy();
        finish(new Error('TrueNAS certificate fingerprint changed'));
      } else { finish(null, socket); }
    });
    socket.setTimeout(10000, () => socket.destroy(new Error('TLS connect timeout')));
    socket.once('error', error => finish(error));
  } });
  const ws = new WebSocket(`wss://${HOST}/api/current`, { dispatcher });
  const pending = new Map();
  let nextId = 0;
  const failPending = () => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('TrueNAS connection closed; write outcome may be unknown'));
    }
    pending.clear();
  };
  ws.addEventListener('close', failPending);
  ws.addEventListener('error', failPending);
  ws.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    // Do not echo arbitrary remote errors, which can contain input values.
    if (message.error) item.reject(new Error(`TrueNAS RPC ${message.error.code} on ${item.method}`));
    else item.resolve(message.result);
  });
  function call(method, params = []) {
    if (ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('TrueNAS socket is not open'));
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`TrueNAS timeout on ${method}; inspect state before retrying writes`));
      }, 45000);
      pending.set(id, { resolve, reject, timer, method });
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    });
  }
  async function close() { ws.close(); failPending(); await dispatcher.destroy(); }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('TrueNAS WebSocket connect timeout')), 12000);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('TrueNAS TLS/WebSocket connection failed')); }, { once: true });
    });
    const login = await call('auth.login_ex', [{ mechanism: 'API_KEY_PLAIN',
      username: credential.username, api_key: credential.api_key, login_options: { user_info: false } }]);
    if (login.response_type !== 'SUCCESS') throw new Error('TrueNAS authentication failed');
    return { call, close };
  } catch (error) { await close(); throw error; }
  finally { credential.api_key = null; }
}

async function main(args) {
  const [action, idText, file] = args;
  if (!['status', 'nfs-list', 'nfs-update'].includes(action)) {
    throw new Error('Usage: node client.cjs status | nfs-list | nfs-update SHARE_ID PATCH.json');
  }
  let id, patch;
  if (action === 'nfs-update') {
    id = Number(idText);
    if (!Number.isSafeInteger(id) || id < 1 || !file) throw new Error('A positive share ID and JSON patch file are required');
    try { patch = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
    catch { throw new Error('Cannot read JSON patch file'); }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length) throw new Error('Patch must be a nonempty JSON object');
  }
  const client = await connect(action === 'nfs-update');
  try {
    if (action === 'status') {
      const version = await client.call('system.version');
      const me = await client.call('auth.me');
      console.log(JSON.stringify({ version, username: me.pw_name || me.username, transport: `wss://${HOST}/api/current` }, null, 2));
    } else if (action === 'nfs-list') {
      console.log(JSON.stringify(await client.call('sharing.nfs.query'), null, 2));
    } else {
      const before = await client.call('sharing.nfs.query', [[['id', '=', id]]]);
      if (before.length !== 1) throw new Error('NFS share not found');
      await client.call('sharing.nfs.update', [id, patch]);
      const after = await client.call('sharing.nfs.query', [[['id', '=', id]]]);
      console.log(JSON.stringify({ id, requested: patch, before: before[0], after: after[0] }, null, 2));
    }
  } finally { await client.close(); }
}
module.exports = { connect };
if (require.main === module) main(process.argv.slice(2)).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
