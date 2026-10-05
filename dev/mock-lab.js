#!/usr/bin/env node
/**
 * Mock lab for development and demos - no real equipment needed
 *
 * Starts a fake SSH jump server (default 127.0.0.1:2222) that accepts the
 * SSH_* credentials from .env and answers `telnet <host> <port>` with a small
 * Cisco-IOS-like console (login with TELNET_* credentials, enable, conf t, show …)
 * Device hostnames are read from the diagram so R1 really answers "R1>"
 *
 *   npm run mock-lab            # then, in .env: SSH_HOST=127.0.0.1  SSH_PORT=2222
 *   MOCK_DOWN_PORTS=2003 npm run mock-lab   # simulate an unplugged console
 *   MOCK_LOGIN_PORTS=2001 npm run mock-lab  # terminal server that prompts "login:" at once
 *                                           # and hangs up on an empty login
 *   MOCK_SLOW_CONSOLE=1 npm run mock-lab    # old devices: ~1 char/ms, 64-byte input buffer,
 *                                           # 40 ms per command; overflowing input is dropped
 *
 * The devices themselves are simulated by dev/fakeIos.js (pagination, config
 * memory, errors), which the unit tests use too
 *
 * It also does SSH port forwarding (direct-tcpip), like a real jump server, so
 * the Proxmox tunnel can be tested; MOCK_FORWARD maps lab addresses to local
 * ones; anything else is refused, as an unreachable lab host would be:
 *   MOCK_FORWARD=<PROXMOX_URL host:port>=127.0.0.1:8006   (default)
 */
import fs from 'node:fs';
import net from 'node:net';
import ssh2 from 'ssh2';
import { parseDrawio } from '../src/modules/consoles/drawio.js';
import { FakeIos } from './fakeIos.js';

try { process.loadEnvFile('.env'); } catch { /* optional */ }
const env = process.env;
const PORT = Number(env.MOCK_SSH_PORT || 2222);
const portSet = (v) => new Set((v || '').split(',').filter(Boolean).map(Number));
const downPorts = portSet(env.MOCK_DOWN_PORTS);
const loginPorts = portSet(env.MOCK_LOGIN_PORTS);
const pveTarget = (() => { try { const u = new URL(env.PROXMOX_URL); return `${u.hostname}:${u.port || 8006}`; } catch { return '10.22.9.71:8006'; } })();
const forwards = new Map((env.MOCK_FORWARD || `${pveTarget}=127.0.0.1:8006`).split(',').filter(Boolean).map((r) => r.split('=')));
const slowConsole = env.MOCK_SLOW_CONSOLE ? { bufferBytes: 64, commandMs: 40 } : null;
let forwardCount = 0;

const names = new Map();
try {
  const { labs } = parseDrawio(fs.readFileSync(env.DIAGRAM_PATH || './diagrams/diagram.drawio', 'utf8'), { networkPrefix: env.CONSOLE_NETWORK_PREFIX || '10.22.9' });
  for (const l of labs) for (const d of l.devices) names.set(`${d.target.host}:${d.target.port}`, d.name);
} catch { /* hostnames fall back to "Router" */ }
try {
  const infra = JSON.parse(fs.readFileSync(env.INFRA_CONFIG_PATH || './config/infrastructure.json', 'utf8'));
  for (const s of infra.adminSwitches || []) names.set(`${s.host}:${s.port}`, `SwitchAdmin-${s.id.toUpperCase()}`);
} catch { /* optional */ }

const hostKey = ssh2.utils.generateKeyPairSync('ed25519').private;

new ssh2.Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === env.SSH_USERNAME && ctx.password === env.SSH_PASSWORD) return ctx.accept();
    ctx.reject(['password']);
  });
  client.on('ready', () => {
    // Port forwarding: the platform's Proxmox tunnel opens these channels
    client.on('tcpip', (accept, reject, info) => {
      const to = forwards.get(`${info.destIP}:${info.destPort}`);
      if (!to) { console.log(`forward refused: ${info.destIP}:${info.destPort}`); return reject(); }
      const [h, p] = to.split(':');
      const upstream = net.connect(Number(p), h);
      upstream.once('connect', () => {
        const channel = accept();
        forwardCount++;
        channel.pipe(upstream).pipe(channel);
        channel.on('close', () => upstream.destroy());
        upstream.on('close', () => channel.close?.());
      });
      upstream.once('error', () => reject());
    });
    client.on('session', (accept) => {
      const session = accept();
      session.on('pty', (ok) => ok?.());
      session.on('window-change', (ok) => ok?.());
      session.on('exec', (acceptExec, _reject, info) => {
        const stream = acceptExec();
        const m = info.command.match(/^telnet\s+([\w.-]+)\s+(\d+)$/);
        if (!m) { stream.stderr.write(`mock: unsupported command: ${info.command}\r\n`); stream.exit(127); return stream.end(); }
        runTelnet(stream, m[1], Number(m[2]));
      });
    });
  });
  client.on('error', () => {});
}).listen(PORT, '127.0.0.1', () => console.log(`Mock jump server on 127.0.0.1:${PORT} (${names.size} devices from the diagram, forwarding ${[...forwards.keys()].join(', ')})`));
setInterval(() => forwardCount && console.log(`forward channels opened so far: ${forwardCount}`), 10_000).unref();

function runTelnet(stream, host, port) {
  const out = (s) => stream.write(s);
  out(`Trying ${host}...\r\n`);
  if (downPorts.has(port)) {
    setTimeout(() => { out('telnet: Unable to connect to remote host: Connection refused\r\n'); stream.exit(1); stream.end(); }, 400);
    return;
  }
  const dev = new FakeIos({
    hostname: names.get(`${host}:${port}`) || 'Router',
    out,
    hangup: () => { dev.stop(); out('\r\nConnection closed by foreign host.\r\n'); stream.exit(0); stream.end(); },
    username: env.TELNET_USERNAME,
    password: env.TELNET_PASSWORD,
    slowConsole,
  });
  setTimeout(() => {
    out(`Connected to ${host}.\r\nEscape character is '^]'.\r\n`);
    if (loginPorts.has(port)) { dev.strict = true; dev.state = 'user'; out('\r\nlogin: '); }
  }, 250);
  stream.on('data', (d) => dev.input(d.toString('latin1')));
  stream.on('close', () => dev.stop());
}
