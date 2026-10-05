#!/usr/bin/env node
/**
 * Mock Proxmox VE API for development, demos and tests
 * Behaves like the real thing where it matters to the platform:
 *
 *   - HTTPS with a self-signed certificate (fingerprint printed at start)
 *   - /access/ticket login, 2 h tickets (MOCK_TICKET_TTL_S to shorten),
 *     401 on missing/expired ticket, 401 on writes without the CSRF token
 *   - cluster/resources, nodes, nextid, qemu config (+digest), pending,
 *     clone / status/* as async tasks with UPIDs, task status
 *   - termproxy + vncwebsocket: a fake serial login shell (pve-xtermjs framing)
 *   - vncproxy + vncwebsocket: a real RFB 3.8 server that *checks* the VNC
 *     password (DES challenge) and draws the VM name, VLAN and key count
 *
 * Seed data follows the bay diagram: VMs 5H1…5B3 on VLAN 2001–2006 and
 * 6H1…6B3 on 2007–2012 (pool "labs"), two templates, one infra VM outside
 * the pool, NICs net0 on vmbr0 (lab trunk) and net1 on vmbr1 (management)
 *
 *   npm run mock-proxmox      then in .env:  PROXMOX_URL=https://127.0.0.1:8006
 *                                             PROXMOX_FINGERPRINT=<printed value>
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { DESECBCipher } from '../node_modules/@novnc/novnc/core/crypto/des.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function startMockProxmox({
  port = 8006, host = '127.0.0.1', tls = true, user = 'labportal@pve', password = 'secret',
  ticketTtlMs = 2 * 3600_000, taskMs = 1500, pool = 'labs', quiet = false,
} = {}) {
  const log = quiet ? () => {} : (...a) => console.log('[mock-pve]', ...a);
  const stats = { requests: 0, logins: 0, rejected401: 0 };
  const tickets = new Map();       // ticket → { user, csrf, exp }
  const consoleTickets = new Map(); // vncticket → { vmid, port, kind, exp }
  const tasks = new Map();         // upid → { done, ok, endAt, then }
  const vms = seed(pool);

  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, _res, next) => { stats.requests++; next(); });
  const ok = (res, data) => res.json({ data });
  const fail = (res, status, msg, errors) => { res.statusMessage = msg; res.status(status).json({ data: null, ...(errors ? { errors } : {}) }); };

  // ── auth ──
  app.post('/api2/json/access/ticket', (req, res) => {
    const { username, password: pw } = req.body;
    if (username !== user || pw !== password) return fail(res, 401, 'authentication failure');
    stats.logins++;
    const ticket = `PVE:${user}:${crypto.randomBytes(6).toString('hex').toUpperCase()}::${crypto.randomBytes(24).toString('base64')}`;
    const csrf = `${crypto.randomBytes(4).toString('hex')}:${crypto.randomBytes(16).toString('base64')}`;
    tickets.set(ticket, { user, csrf, exp: Date.now() + ticketTtlMs });
    ok(res, { ticket, CSRFPreventionToken: csrf, username: user, cap: {} });
  });
  const session = (req) => {
    const m = /PVEAuthCookie=([^;]+)/.exec(req.headers.cookie || '');
    const t = m && tickets.get(decodeURIComponent(m[1]));
    return t && t.exp > Date.now() ? t : null;
  };
  app.use('/api2/json', (req, res, next) => {
    const s = session(req);
    if (!s) { stats.rejected401++; return fail(res, 401, 'No ticket'); }
    if (req.method !== 'GET' && req.headers.csrfpreventiontoken !== s.csrf) return fail(res, 401, 'Permission check failed (invalid csrf token)');
    next();
  });

  // ── read ──
  app.get('/api2/json/nodes', (_q, res) => ok(res, [{ node: 'pve1', status: 'online' }, { node: 'pve2', status: 'online' }]));
  app.get('/api2/json/cluster/nextid', (_q, res) => ok(res, String(Math.max(...[...vms.keys()].filter((id) => id < 9000)) + 1)));
  app.get('/api2/json/cluster/resources', (_q, res) => ok(res, [...vms.values()].map((v) => ({
    type: 'qemu', id: `qemu/${v.vmid}`, vmid: v.vmid, name: v.config.name, node: v.node, status: v.status,
    template: v.config.template ? 1 : 0, pool: v.pool, maxcpu: 2, maxmem: 2 * 1073741824, uptime: v.status === 'running' ? 3600 : 0,
  }))));
  const vmOf = (req, res) => {
    const v = vms.get(Number(req.params.vmid));
    if (!v || v.node !== req.params.node) { fail(res, 500, `Configuration file 'nodes/${req.params.node}/qemu-server/${req.params.vmid}.conf' does not exist`); return null; }
    return v;
  };
  const digest = (v) => crypto.createHash('sha1').update(JSON.stringify(v.config)).digest('hex');
  app.get('/api2/json/nodes/:node/qemu/:vmid/config', (req, res) => { const v = vmOf(req, res); if (v) ok(res, { ...v.config, digest: digest(v) }); });
  app.get('/api2/json/nodes/:node/qemu/:vmid/pending', (req, res) => { const v = vmOf(req, res); if (v) ok(res, []); });

  // ── write ──
  app.put('/api2/json/nodes/:node/qemu/:vmid/config', (req, res) => {
    const v = vmOf(req, res); if (!v) return;
    if (req.body.digest && req.body.digest !== digest(v)) return fail(res, 500, 'detected modified configuration - file changed by other user? Try again.');
    for (const [k, val] of Object.entries(req.body)) {
      if (k === 'digest') continue;
      if (/^net\d+$/.test(k) && !/^(virtio|e1000|vmxnet3|rtl8139)=([0-9A-F]{2}:){5}[0-9A-F]{2},bridge=vmbr\d+/i.test(val)) {
        return fail(res, 400, 'Parameter verification failed.', { [k]: 'invalid format' });
      }
      v.config[k] = val;
    }
    log(`VM ${v.vmid} config ←`, req.body);
    ok(res, null);
  });
  const task = (node, type, id, then) => {
    const upid = `UPID:${node}:${crypto.randomBytes(4).toString('hex').toUpperCase()}:${Date.now().toString(16)}:${type}:${id}:${user}:`;
    tasks.set(upid, { endAt: Date.now() + taskMs, then, done: false, ok: true });
    return upid;
  };
  app.post('/api2/json/nodes/:node/qemu/:vmid/status/:action', (req, res) => {
    const v = vmOf(req, res); if (!v) return;
    const to = { start: 'running', stop: 'stopped', shutdown: 'stopped', reboot: 'running' }[req.params.action];
    if (!to) return fail(res, 501, 'Method not implemented');
    ok(res, task(v.node, `qm${req.params.action}`, v.vmid, () => { v.status = to; }));
  });
  app.post('/api2/json/nodes/:node/qemu/:vmid/clone', (req, res) => {
    const tpl = vmOf(req, res); if (!tpl) return;
    const newid = Number(req.body.newid);
    if (vms.has(newid)) return fail(res, 500, `VM ${newid} already exists`);
    const target = req.body.target || tpl.node;
    ok(res, task(tpl.node, 'qmclone', tpl.vmid, () => {
      const config = { ...structuredClone(tpl.config), name: req.body.name };
      delete config.template;
      for (const k of Object.keys(config)) if (/^net\d+$/.test(k)) config[k] = config[k].replace(/=([0-9A-F]{2}:){5}[0-9A-F]{2}/i, `=${mac()}`);
      vms.set(newid, { vmid: newid, node: target, status: 'stopped', pool: req.body.pool || null, config, keys: 0 });
    }));
  });
  app.get('/api2/json/nodes/:node/tasks/:upid/status', (req, res) => {
    const t = tasks.get(req.params.upid);
    if (!t) return fail(res, 500, 'no such task');
    if (!t.done && Date.now() >= t.endAt) { t.done = true; t.then?.(); }
    ok(res, t.done ? { status: 'stopped', exitstatus: 'OK' } : { status: 'running' });
  });

  // ── consoles ──
  const consoleTicket = (v, kind) => {
    const ticket = `PVEVNC:${crypto.randomBytes(4).toString('hex').toUpperCase()}::${crypto.randomBytes(20).toString('base64')}`;
    const port = 5900 + Math.floor(Math.random() * 100);
    consoleTickets.set(ticket, { vmid: v.vmid, port, kind, exp: Date.now() + 40_000 });
    return { ticket, port: String(port), user, upid: `UPID:${v.node}:${kind}` };
  };
  app.post('/api2/json/nodes/:node/qemu/:vmid/termproxy', (req, res) => {
    const v = vmOf(req, res); if (!v) return;
    if (!v.config[req.body.serial || 'serial0']) return fail(res, 500, 'serial port not configured');
    ok(res, consoleTicket(v, 'term'));
  });
  app.post('/api2/json/nodes/:node/qemu/:vmid/vncproxy', (req, res) => {
    const v = vmOf(req, res); if (!v) return;
    if (v.status !== 'running') return fail(res, 500, `VM ${v.vmid} not running`);
    ok(res, { ...consoleTicket(v, 'vnc'), cert: '-----BEGIN CERTIFICATE-----mock' });
  });

  // ── server ──
  let server;
  let fingerprint = null;
  if (tls) {
    const { key, cert } = selfSignedCert();
    server = https.createServer({ key, cert }, app);
    fingerprint = new crypto.X509Certificate(cert).fingerprint256;
  } else {
    server = http.createServer(app);
  }
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/api2\/json\/nodes\/([\w-]+)\/qemu\/(\d+)\/vncwebsocket$/);
    const s = session(req);
    const ct = consoleTickets.get(url.searchParams.get('vncticket'));
    const v = m && vms.get(Number(m[2]));
    if (!m || !s || !ct || ct.exp < Date.now() || ct.vmid !== v?.vmid || String(ct.port) !== url.searchParams.get('port')) {
      log('vncwebsocket refused', { path: url.pathname, session: Boolean(s), ticket: Boolean(ct) });
      return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    }
    consoleTickets.delete(url.searchParams.get('vncticket')); // single use
    wss.handleUpgrade(req, socket, head, (ws) => (ct.kind === 'term'
      ? serialShell(ws, v, url.searchParams.get('vncticket'), user)
      : rfbServer(ws, v, url.searchParams.get('vncticket'), log)));
  });
  await new Promise((r) => server.listen(port, host, r));
  const url = `${tls ? 'https' : 'http'}://${host}:${server.address().port}`;
  log(`listening on ${url}${fingerprint ? `\n  PROXMOX_FINGERPRINT=${fingerprint}` : ''}\n  user ${user}`);
  return { url, fingerprint, stats, vms, tickets, close: () => new Promise((r) => { wss.clients.forEach((c) => c.terminate()); server.closeAllConnections?.(); server.close(r); }) };
}

// ─── Seed data ──────────────────────────────────────────────────────────────

function seed(pool) {
  const vms = new Map();
  const add = (vmid, name, node, extra = {}, status = 'running', inPool = true) =>
    vms.set(vmid, { vmid, node, status, pool: inPool ? pool : null, keys: 0, config: { name, cores: 2, memory: 2048, ostype: 'l26', ...extra } });
  const labs = ['5H1', '5H2', '5H3', '5B1', '5B2', '5B3', '6H1', '6H2', '6H3', '6B1', '6B2', '6B3'];
  labs.forEach((name, i) => {
    const linux = name.startsWith('5');
    add(500 + i + 1, name, i < 6 ? 'pve1' : 'pve2', {
      net0: `virtio=${mac()},bridge=vmbr0,firewall=0,tag=${2001 + i}`,
      net1: `virtio=${mac()},bridge=vmbr1`,
      ...(linux ? { serial0: 'socket', vga: 'serial0' } : { ostype: 'win11' }),
    }, i % 5 === 4 ? 'stopped' : 'running');
  });
  add(9000, 'tpl-debian12', 'pve1', { template: 1, serial0: 'socket', net0: `virtio=${mac()},bridge=vmbr0` }, 'stopped');
  add(9001, 'tpl-win11', 'pve1', { template: 1, ostype: 'win11', net0: `e1000=${mac()},bridge=vmbr0` }, 'stopped');
  add(100, 'infra-dns', 'pve1', { net0: `virtio=${mac()},bridge=vmbr1` }, 'running', false);
  return vms;
}
function mac() {
  return ['BC', '24', '11', ...Array.from(crypto.randomBytes(3), (b) => b.toString(16).padStart(2, '0').toUpperCase())].join(':');
}

function selfSignedCert() {
  const dir = path.join(HERE, '.mock-certs');
  const key = path.join(dir, 'key.pem'), cert = path.join(dir, 'cert.pem');
  if (!fs.existsSync(cert)) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
      '-days', '3650', '-subj', '/CN=pve-mock', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'], { stdio: 'ignore' });
  }
  return { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
}

// ─── termproxy: fake serial login shell (pve-xtermjs framing) ───────────────

function serialShell(ws, vm, ticket, user) {
  let authed = false, state = 'login', line = '';
  const out = (s) => ws.send(Buffer.from(s.replace(/\n/g, '\r\n')));
  const name = () => vm.config.name;
  const vlan = () => (/tag=(\d+)/.exec(vm.config.net0 || '') || [])[1] || 'none';
  const prompt = () => out(state === 'login' ? `${name()} login: ` : state === 'pass' ? 'Password: ' : `root@${name()}:~# `);
  const run = (cmd) => {
    const [c, ...args] = cmd.trim().split(/\s+/);
    if (!c) return;
    if (c === 'hostname') out(`${name()}\n`);
    else if (c === 'uname') out(`Linux ${name()} 6.1.0-mock #1 SMP Debian 6.1.0 x86_64 GNU/Linux\n`);
    else if (c === 'ip') out(`2: ens18: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500\n    link/ether ${(vm.config.net0.match(/=([0-9A-F:]{17})/i) || [])[1]}\n    # attached to VLAN ${vlan()} on vmbr0\n`);
    else if (c === 'echo') out(`${args.join(' ')}\n`);
    else if (c === 'exit' || c === 'logout') { state = 'login'; out('\nlogout\n\n'); }
    else out(`-bash: ${c}: command not found\n`);
  };
  ws.on('message', (raw) => {
    const msg = raw.toString();
    if (!authed) {
      if (msg !== `${user}:${ticket}\n`) return ws.close();
      authed = true;
      ws.send('OK');
      return out(`\nDebian GNU/Linux 12 ${name()} ttyS0 (mock serial console, VLAN ${vlan()})\n\n`);
    }
    if (msg === '2' || msg.startsWith('1:')) return; // keep-alive / resize
    const m = /^0:(\d+):([\s\S]*)$/.exec(msg);
    if (!m) return;
    for (const ch of m[2]) {
      if (ch === '\r') {
        out('\n');
        if (state === 'login') { state = line ? 'pass' : 'login'; }
        else if (state === 'pass') { state = 'shell'; out(`Linux ${name()} 6.1.0-mock\n\n`); }
        else run(line);
        line = '';
        prompt();
      } else if (ch === '\x7f') { if (line) { line = line.slice(0, -1); if (state !== 'pass') out('\b \b'); } }
      else if (ch >= ' ') { line += ch; if (state !== 'pass') out(ch); }
    }
  });
}

// ─── vncproxy: minimal RFB 3.8 server with real VNC authentication ──────────

const FONT = {
  A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
  F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
  K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
  P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
  U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
  Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
  4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
  9: '111101111001110', ' ': '000000000000000', '-': '000000111000000', ':': '000010000010000', '.': '000000000000010',
};

function rfbServer(ws, vm, ticket, log) {
  const W = 640, H = 400;
  let buf = Buffer.alloc(0);
  let stage = 'version';
  let challenge;
  let fmt = { bpp: 32, bigEndian: 0, rs: 16, gs: 8, bs: 0 };
  ws.send(Buffer.from('RFB 003.008\n'));

  const frame = () => {
    const px = Buffer.alloc(W * H * 4);
    const put = (x, y, [r, g, b]) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return;
      const v = ((r << fmt.rs) | (g << fmt.gs) | (b << fmt.bs)) >>> 0;
      fmt.bigEndian ? px.writeUInt32BE(v, (y * W + x) * 4) : px.writeUInt32LE(v, (y * W + x) * 4);
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, [16 + y / 12, 40 + y / 8, 70 + x / 10]);
    const text = (s, x0, y0, scale, color) => [...s.toUpperCase()].forEach((ch, i) => {
      const g = FONT[ch] || FONT[' '];
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[r * 3 + c] === '1') {
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) put(x0 + i * 4 * scale + c * scale + dx, y0 + r * scale + dy, color);
      }
    });
    const vlan = (/tag=(\d+)/.exec(vm.config.net0 || '') || [])[1] || 'NONE';
    text(vm.config.name, 40, 60, 16, [255, 255, 255]);
    text(`VLAN ${vlan}`, 40, 200, 8, [124, 195, 240]);
    text(`KEYS: ${vm.keys}`, 40, 280, 6, [242, 196, 98]);
    text('MOCK VNC CONSOLE', 40, 350, 4, [180, 190, 200]);
    const head = Buffer.alloc(16);
    head.writeUInt8(0, 0); head.writeUInt16BE(1, 2);
    head.writeUInt16BE(0, 4); head.writeUInt16BE(0, 6); head.writeUInt16BE(W, 8); head.writeUInt16BE(H, 10); head.writeInt32BE(0, 12);
    ws.send(Buffer.concat([head, px]));
  };

  let dirty = true;
  ws.on('message', (d) => {
    buf = Buffer.concat([buf, d]);
    for (;;) {
      if (stage === 'version') {
        if (buf.length < 12) return;
        buf = buf.subarray(12);
        ws.send(Buffer.from([1, 2])); // one security type: VNC authentication
        stage = 'sectype';
      } else if (stage === 'sectype') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        challenge = crypto.randomBytes(16);
        ws.send(challenge);
        stage = 'auth';
      } else if (stage === 'auth') {
        if (buf.length < 16) return;
        const got = buf.subarray(0, 16); buf = buf.subarray(16);
        const key = Array.from(ticket.slice(0, 8), (c) => c.charCodeAt(0));
        const want = Buffer.from(DESECBCipher.importKey(key).encrypt({ name: 'DES-ECB' }, [...challenge]));
        if (!want.equals(got)) {
          log(`VNC auth FAILED for VM ${vm.vmid}`);
          const reason = Buffer.from('Authentication failed');
          const r = Buffer.alloc(8); r.writeUInt32BE(1, 0); r.writeUInt32BE(reason.length, 4);
          ws.send(Buffer.concat([r, reason]));
          return ws.close();
        }
        log(`VNC auth OK for VM ${vm.vmid}`);
        ws.send(Buffer.from([0, 0, 0, 0]));
        stage = 'clientinit';
      } else if (stage === 'clientinit') {
        if (buf.length < 1) return;
        buf = buf.subarray(1);
        const name = Buffer.from(`${vm.config.name} (mock)`);
        const si = Buffer.alloc(24);
        si.writeUInt16BE(W, 0); si.writeUInt16BE(H, 2);
        Buffer.from([32, 24, 0, 1, 0, 255, 0, 255, 0, 255, 16, 8, 0, 0, 0, 0]).copy(si, 4);
        si.writeUInt32BE(name.length, 20);
        ws.send(Buffer.concat([si, name]));
        stage = 'normal';
      } else {
        if (buf.length < 1) return;
        const type = buf[0];
        const need = { 0: 20, 2: 4, 3: 10, 4: 8, 5: 6, 6: 8 }[type];
        if (need === undefined) { buf = Buffer.alloc(0); return; }
        let len = need;
        if (type === 2) { if (buf.length < 4) return; len = 4 + 4 * buf.readUInt16BE(2); }
        if (type === 6) { if (buf.length < 8) return; len = 8 + buf.readUInt32BE(4); }
        if (buf.length < len) return;
        const msg = buf.subarray(0, len); buf = buf.subarray(len);
        if (type === 0) fmt = { bpp: msg[4], bigEndian: msg[6], rs: msg[14], gs: msg[15], bs: msg[16] };
        if (type === 4 && msg[1] === 1) { vm.keys++; dirty = true; }
        if (type === 3 && (msg[1] === 0 || dirty)) { dirty = false; frame(); }
      }
    }
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.loadEnvFile('.env'); } catch { /* optional */ }
  const e = process.env;
  const userid = (e.PROXMOX_USERNAME || 'labportal').includes('@') ? e.PROXMOX_USERNAME : `${e.PROXMOX_USERNAME || 'labportal'}@${e.PROXMOX_REALM || 'pve'}`;
  startMockProxmox({
    port: Number(e.MOCK_PROXMOX_PORT || 8006),
    tls: e.MOCK_PROXMOX_TLS !== 'false',
    user: userid,
    password: e.PROXMOX_PASSWORD || 'secret',
    ticketTtlMs: Number(e.MOCK_TICKET_TTL_S || 7200) * 1000,
  });
}
