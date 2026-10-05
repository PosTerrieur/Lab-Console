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
 *
 * It also does SSH port forwarding (direct-tcpip), like a real jump server, so
 * the Proxmox tunnel can be tested; MOCK_FORWARD maps lab addresses to local
 * ones; anything else is refused, as an unreachable lab host would be:
 *   MOCK_FORWARD=10.22.9.20:8006=127.0.0.1:8006   (default)
 */
import fs from 'node:fs';
import net from 'node:net';
import ssh2 from 'ssh2';
import { parseDrawio } from '../src/modules/consoles/drawio.js';

try { process.loadEnvFile('.env'); } catch { /* optional */ }
const env = process.env;
const PORT = Number(env.MOCK_SSH_PORT || 2222);
const portSet = (v) => new Set((v || '').split(',').filter(Boolean).map(Number));
const downPorts = portSet(env.MOCK_DOWN_PORTS);
const loginPorts = portSet(env.MOCK_LOGIN_PORTS);
const forwards = new Map((env.MOCK_FORWARD || '10.22.9.20:8006=127.0.0.1:8006').split(',').filter(Boolean).map((r) => r.split('=')));
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
  const dev = new FakeIos(names.get(`${host}:${port}`) || 'Router', out, () => {
    out('\r\nConnection closed by foreign host.\r\n'); stream.exit(0); stream.end();
  });
  setTimeout(() => {
    out(`Connected to ${host}.\r\nEscape character is '^]'.\r\n`);
    if (loginPorts.has(port)) { dev.strict = true; dev.state = 'user'; out('\r\nlogin: '); }
  }, 250);
  stream.on('data', (d) => dev.input(d.toString('latin1')));
  stream.on('close', () => dev.stop());
}

/** A deliberately small IOS imitation: enough to demo the UI convincingly */
class FakeIos {
  constructor(hostname, out, hangup) {
    Object.assign(this, { hostname, out, hangup });
    this.state = 'banner'; // banner → user → pass → exec
    this.line = '';
    this.mode = '>';
    this.telnetCmd = null;
    this.iface = '';
  }
  stop() {}
  prompt() {
    const sub = { '>': '>', '#': '#', config: '(config)#', 'config-if': '(config-if)#' }[this.mode];
    this.out(`\r\n${this.hostname}${sub}`);
  }
  input(data) {
    for (const ch of data) {
      if (this.telnetCmd !== null) { this.telnetKey(ch); continue; }
      if (ch === '\x1d') { this.telnetCmd = ''; this.out('\r\ntelnet> '); continue; }
      if (this.state === 'banner') {
        if (ch === '\r') { this.state = 'user'; this.out('\r\n\r\nUser Access Verification\r\n\r\nUsername: '); }
        continue;
      }
      if (ch === '\r' || ch === '\n') { if (ch === '\r') this.enter(); continue; }
      if (ch === '\x7f' || ch === '\b') { if (this.line) { this.line = this.line.slice(0, -1); if (this.state !== 'pass') this.out('\b \b'); } continue; }
      if (ch === '\x03') { this.line = ''; if (this.state === 'exec') { if (this.mode !== '>' && this.mode !== '#') this.mode = '#'; this.prompt(); } continue; }
      if (ch === '?' && this.state === 'exec') { this.out('?'); this.help(); this.out(this.line); continue; }
      if (ch < ' ') continue;
      this.line += ch;
      if (this.state !== 'pass') this.out(ch);
    }
  }
  telnetKey(ch) {
    if (ch !== '\r') { this.telnetCmd += ch; this.out(ch); return; }
    const cmd = this.telnetCmd.trim(); this.telnetCmd = null;
    if (cmd === 'send brk') this.out('\r\n\r\n*** Break received - a real router would now drop to ROMMON ***');
    this.prompt();
  }
  enter() {
    const line = this.line.trim(); this.line = '';
    if (this.state === 'user' && !line && this.strict) return this.hangup(); // like a strict terminal server
    if (this.state === 'user') { this.user = line; this.state = 'pass'; return this.out('\r\nPassword: '); }
    if (this.state === 'pass') {
      if (this.user === env.TELNET_USERNAME && line === env.TELNET_PASSWORD) {
        this.state = 'exec'; this.out('\r\n'); return this.prompt();
      }
      this.state = 'user'; return this.out('\r\n% Login invalid\r\n\r\nUsername: ');
    }
    this.exec(line);
  }
  help() {
    const cmds = this.mode.startsWith('config') ? ['end', 'exit', 'hostname', 'interface'] : ['configure', 'disable', 'enable', 'exit', 'ping', 'show'];
    this.out('\r\n' + cmds.map((c) => `  ${c}`).join('\r\n'));
    this.prompt();
  }
  exec(line) {
    const [cmd = '', ...args] = line.split(/\s+/);
    const is = (full, min = 2) => cmd.length >= min && full.startsWith(cmd.toLowerCase());
    const say = (s) => this.out('\r\n' + s.replace(/\n/g, '\r\n'));
    if (!line) return this.prompt();
    if (this.mode === 'config' || this.mode === 'config-if') {
      if (is('hostname') && args[0]) this.hostname = args[0];
      else if (is('interface', 3)) { this.iface = args.join(''); this.mode = 'config-if'; }
      else if (is('exit')) this.mode = this.mode === 'config-if' ? 'config' : '#';
      else if (is('end')) this.mode = '#';
      else if (['ip', 'no', 'shutdown', 'description', 'switchport', 'vlan', 'router', 'network', 'line', 'password', 'login', 'enable', 'service', 'banner'].includes(cmd.toLowerCase())) { /* accepted */ }
      else say(`% Invalid input detected at '^' marker.`);
      return this.prompt();
    }
    if (is('enable')) this.mode = '#';
    else if (is('disable', 3)) this.mode = '>';
    else if (is('exit') || is('logout', 4)) return this.hangup();
    else if (is('configure', 4) && this.mode === '#') { say('Enter configuration commands, one per line.  End with CNTL/Z.'); this.mode = 'config'; }
    else if (is('show', 2)) this.show(args.join(' '), say);
    else if (is('ping')) say(`Type escape sequence to abort.\nSending 5, 100-byte ICMP Echos to ${args[0] || '?'}, timeout is 2 seconds:\n!!!!!\nSuccess rate is 100 percent (5/5), round-trip min/avg/max = 1/2/4 ms`);
    else say(`% Unknown command or computer name, or unable to find computer address`);
    this.prompt();
  }
  show(what, say) {
    const router = /^R/i.test(this.hostname);
    if (/^ver/.test(what)) say(`Cisco IOS Software, ${router ? 'ISR4300 Software (X86_64_LINUX_IOSD-UNIVERSALK9-M)' : 'C2960 Software (C2960-LANBASEK9-M)'}, Version 15.2(7)E (mock)\n${this.hostname} uptime is 3 hours, 12 minutes\nThis is a simulated device from dev/mock-lab.js`);
    else if (/^ip int/.test(what)) say(router
      ? 'Interface              IP-Address      OK? Method Status                Protocol\nGigabitEthernet0/0/0   192.168.1.1     YES manual up                    up\nGigabitEthernet0/0/1   unassigned      YES unset  administratively down down\nSerial0/1/0            10.0.0.1        YES manual up                    up'
      : 'Interface              IP-Address      OK? Method Status                Protocol\nVlan1                  unassigned      YES unset  administratively down down\nFastEthernet0/1        unassigned      YES unset  up                    up\nFastEthernet0/2        unassigned      YES unset  down                  down');
    else if (/^run/.test(what)) say(`Building configuration...\n\nCurrent configuration : 1024 bytes\n!\nhostname ${this.hostname}\n!\nend`);
    else say(`% Incomplete command.`);
  }
}
