/**
 * A small Cisco IOS imitation for the mock lab and the tests
 *
 * Realistic where the platform's automation depends on it:
 *   - character echo, Username/Password login, user (>) and privileged (#)
 *     modes, configuration modes with their prompts (config)# (config-if)# …
 *   - `show running-config` built from what was actually configured, and
 *     PAGINATED with " --More-- " unless `terminal length 0` was set
 *     (space = next page, Enter = next line, q = stop), erased with
 *     backspaces like IOS does
 *   - `% Invalid input detected at '^' marker.` for unknown or garbled input
 *   - `copy running-config startup-config` asks "Destination filename [startup-config]?"
 *
 * Optional `slowConsole` models an old device behind a 9600-baud console:
 * about 1 character/ms, a small input buffer (64 bytes) and a processing time
 * per command, during which input queues up; Bytes beyond the buffer are
 * DROPPED, which is exactly what corrupts naively pasted scripts
 */
const IFACE_ABBR = [
  [/^gi?g?a?b?i?t?e?t?h?e?r?n?e?t?\s*(\d.*)$/i, 'GigabitEthernet'],
  [/^fa?s?t?e?t?h?e?r?n?e?t?\s*(\d.*)$/i, 'FastEthernet'],
  [/^se?r?i?a?l?\s*(\d.*)$/i, 'Serial'],
  [/^vl?a?n?\s*(\d+)$/i, 'Vlan'],
  [/^lo?o?p?b?a?c?k?\s*(\d+)$/i, 'Loopback'],
];
const GLOBAL_WORDS = new Set(['ip', 'no', 'service', 'enable', 'banner', 'username', 'spanning-tree', 'vlan', 'router',
  'access-list', 'logging', 'clock', 'cdp', 'snmp-server', 'ntp', 'crypto', 'line', 'interface', 'hostname', 'end', 'exit', 'do']);

export class FakeIos {
  constructor({ hostname = 'Router', out, hangup = () => {}, username, password, termLengthSupported = true, slowConsole = null }) {
    Object.assign(this, { out, hangup, username, password, termLengthSupported, slowConsole });
    this.state = 'banner'; // banner → user → pass → exec | more
    this.mode = '>';
    this.line = '';
    this.termLength = 24;
    this.telnetCmd = null;
    this.dropped = 0;
    this.commandLog = [];
    const router = /^R/i.test(hostname);
    this.cfg = {
      hostname,
      global: ['service timestamps debug datetime msec', 'no ip domain-lookup'],
      interfaces: new Map((router
        ? ['GigabitEthernet0/0/0', 'GigabitEthernet0/0/1', 'Serial0/1/0', 'Serial0/1/1']
        : [...Array.from({ length: 24 }, (_, i) => `FastEthernet0/${i + 1}`), 'Vlan1']
      ).map((n) => [n, { lines: [], shutdown: router || n === 'Vlan1' }])),
      lineCon: ['logging synchronous'],
    };
    this.ifaceName = null;
    if (slowConsole) {
      this.queue = [];
      this.busy = false;
      this.timer = setInterval(() => this.#pump(), 1);
    }
  }

  stop() { clearInterval(this.timer); }

  /** Bytes from the terminal server (the student's keystrokes) */
  input(data) {
    if (!this.slowConsole) { for (const ch of data) this.#char(ch); return; }
    for (const ch of data) {
      if (this.queue.length >= this.slowConsole.bufferBytes) this.dropped++;
      else this.queue.push(ch);
    }
  }

  // ── slow console: ~1 char/ms, nothing processed while a command runs ──────
  #pump() {
    if (this.busy) return;
    const ch = this.queue.shift();
    if (ch !== undefined) this.#char(ch);
  }

  #char(ch) {
    if (this.telnetCmd !== null) return this.#telnetKey(ch);
    if (ch === '\x1d') { this.telnetCmd = ''; return this.out('\r\ntelnet> '); }
    if (this.state === 'banner') {
      if (ch === '\r') { this.state = 'user'; this.out('\r\n\r\nUser Access Verification\r\n\r\nUsername: '); }
      return;
    }
    if (this.state === 'more') return this.#moreKey(ch);
    if (ch === '\n') return;
    if (ch === '\r') return this.#enter();
    if (ch === '\x7f' || ch === '\b') {
      if (this.line) { this.line = this.line.slice(0, -1); if (this.state !== 'pass') this.out('\b \b'); }
      return;
    }
    if (ch === '\x03') { this.line = ''; if (this.state === 'exec') { if (this.mode.startsWith('config')) this.mode = '#'; this.#prompt(); } return; }
    if (ch < ' ') return;
    this.line += ch;
    if (this.state !== 'pass') this.out(ch);
  }

  #telnetKey(ch) {
    if (ch !== '\r') { this.telnetCmd += ch; this.out(ch); return; }
    const cmd = this.telnetCmd.trim(); this.telnetCmd = null;
    if (cmd === 'send brk') this.out('\r\n\r\n*** Break received - a real router would now drop to ROMMON ***');
    this.#prompt();
  }

  #prompt() {
    const sub = { '>': '>', '#': '#', config: '(config)#', 'config-if': '(config-if)#', 'config-line': '(config-line)#' }[this.mode];
    this.out(`\r\n${this.cfg.hostname}${sub}`);
  }

  #enter() {
    const line = this.line; this.line = '';
    if (this.state === 'user' && !line.trim() && this.strict) return this.hangup(); // like a strict terminal server
    if (this.state === 'user') { this.user = line.trim(); this.state = 'pass'; return this.out('\r\nPassword: '); }
    if (this.state === 'pass') {
      if (this.user === this.username && line === this.password) { this.state = 'exec'; this.out('\r\n'); return this.#prompt(); }
      this.state = 'user'; return this.out('\r\n% Login invalid\r\n\r\nUsername: ');
    }
    if (this.state === 'motd') { // multi-line banner body: no prompt until the delimiter
      this.bannerLines.push(line);
      this.out('\r\n');
      if (line.includes(this.bannerDelim)) { this.cfg.global.push(`banner motd ^C${this.bannerLines.join('\n').replace(this.bannerDelim, '')}^C`); this.state = 'exec'; this.#prompt(); }
      return;
    }
    if (this.state === 'question') { this.state = 'exec'; this.out(`\r\n${this.questionThen}`); return this.#prompt(); }
    this.commandLog.push(line);
    const run = () => this.#exec(line.trim());
    if (this.slowConsole && line.trim()) {
      this.busy = true; // the device is busy applying the command; input piles up
      setTimeout(() => { this.busy = false; run(); }, this.slowConsole.commandMs);
    } else run();
  }

  // ── commands ──────────────────────────────────────────────────────────────
  #invalid(line) {
    const at = Math.max(0, line.search(/\S/));
    this.out(`\r\n${' '.repeat(this.cfg.hostname.length + this.#promptSuffix().length + at)}^\r\n% Invalid input detected at '^' marker.\r\n`);
  }
  #promptSuffix() {
    return { '>': '>', '#': '#', config: '(config)#', 'config-if': '(config-if)#', 'config-line': '(config-line)#' }[this.mode];
  }

  #exec(line) {
    const say = (s) => this.out('\r\n' + s.replace(/\n/g, '\r\n'));
    if (!line) return this.#prompt();
    const [cmd, ...args] = line.split(/\s+/);
    const c = cmd.toLowerCase();
    const is = (full, min = 2) => c.length >= min && full.startsWith(c);

    if (this.mode.startsWith('config')) {
      if (is('end', 2)) { this.mode = '#'; return this.#prompt(); }
      if (is('exit', 2)) { this.mode = this.mode === 'config' ? '#' : 'config'; return this.#prompt(); }
      if (c === 'do') { const m = this.mode; this.mode = '#'; this.#exec(args.join(' ')); this.mode = m; return; }
      if (is('interface', 3)) {
        const name = normalizeIface(args.join(''));
        if (!name) { this.#invalid(line); return this.#prompt(); }
        if (!this.cfg.interfaces.has(name)) this.cfg.interfaces.set(name, { lines: [], shutdown: false });
        this.ifaceName = name; this.mode = 'config-if'; return this.#prompt();
      }
      if (is('line', 2)) { this.mode = 'config-line'; return this.#prompt(); }
      if (is('hostname', 4) && args[0]) { this.cfg.hostname = args[0]; return this.#prompt(); }
      // Like IOS: a global command typed in a sub-mode leaves the sub-mode and runs globally.
      const SUB = { 'config-if': ['shutdown', 'shut', 'no', 'description', 'ip', 'switchport', 'duplex', 'speed', 'encapsulation', 'clock', 'bandwidth', 'spanning-tree', 'channel-group'],
        'config-line': ['password', 'login', 'logging', 'exec-timeout', 'transport', 'no'] }[this.mode];
      if (SUB && !SUB.includes(c) && (GLOBAL_WORDS.has(c) || c === 'banner')) { this.mode = 'config'; return this.#exec(line); }
      if (this.mode === 'config-if') {
        const ifc = this.cfg.interfaces.get(this.ifaceName);
        if (c === 'shutdown' || c === 'shut') { ifc.shutdown = true; return this.#prompt(); }
        if (c === 'no' && /^shut/.test(args[0] || '')) { ifc.shutdown = false; return this.#prompt(); }
        if (['description', 'ip', 'switchport', 'no', 'duplex', 'speed', 'encapsulation', 'clock', 'bandwidth', 'spanning-tree', 'channel-group'].includes(c)) {
          if (c === 'ip' && args[0] === 'address' && !(isIp(args[1]) && isIp(args[2]))) { this.#invalid(line); return this.#prompt(); }
          ifc.lines = ifc.lines.filter((l) => !(c !== 'no' && l.split(' ').slice(0, 2).join(' ') === `${c} ${args[0]}`));
          ifc.lines.push(line.replace(/\s+/g, ' '));
          return this.#prompt();
        }
        this.#invalid(line); return this.#prompt();
      }
      if (this.mode === 'config-line') {
        if (['password', 'login', 'logging', 'exec-timeout', 'transport', 'no'].includes(c)) { this.cfg.lineCon.push(line.replace(/\s+/g, ' ')); return this.#prompt(); }
        this.#invalid(line); return this.#prompt();
      }
      if (c === 'banner' && args.length >= 2) {
        const body = args.slice(1).join(' ');
        const delim = body[0];
        if (body.indexOf(delim, 1) > 0) { this.cfg.global.push(`banner ${args[0]} ^C${body.slice(1, body.indexOf(delim, 1))}^C`); return this.#prompt(); }
        this.state = 'motd'; this.bannerDelim = delim; this.bannerLines = [];
        return this.out(`\r\nEnter TEXT message.  End with the character '${delim}'.\r\n`);
      }
      if (GLOBAL_WORDS.has(c)) {
        if (c === 'ip' && args[0] === 'route' && !(isIp(args[1]) && isIp(args[2]))) { this.#invalid(line); return this.#prompt(); }
        this.cfg.global.push(line.replace(/\s+/g, ' '));
        return this.#prompt();
      }
      this.#invalid(line); return this.#prompt();
    }

    if (is('enable')) { this.mode = '#'; return this.#prompt(); }
    if (is('disable', 3)) { this.mode = '>'; return this.#prompt(); }
    if (is('exit') || is('logout', 4)) return this.hangup();
    if (is('terminal', 3)) {
      if (!this.termLengthSupported) { this.#invalid(line); return this.#prompt(); }
      if (/^len/i.test(args[0] || '') && /^\d+$/.test(args[1] || '')) { this.termLength = Number(args[1]); return this.#prompt(); }
      if (args[0] === 'no' && /^len/i.test(args[1] || '')) { this.termLength = 24; return this.#prompt(); }
      say('% Incomplete command.'); return this.#prompt();
    }
    if (is('show', 2)) {
      const what = args.join(' ').toLowerCase();
      if (/^run/.test(what)) {
        if (this.mode !== '#') { this.#invalid(line); return this.#prompt(); }
        return this.#page(this.#runningConfig());
      }
      if (/^ver/.test(what)) { say(`Cisco IOS Software, Version 15.2(7)E (mock)\n${this.cfg.hostname} uptime is 3 hours, 12 minutes`); return this.#prompt(); }
      if (/^ip int/.test(what)) {
        return this.#page(['Interface              IP-Address      OK? Method Status                Protocol',
          ...[...this.cfg.interfaces].map(([n, i]) => {
            const ip = (i.lines.find((l) => l.startsWith('ip address ')) || '').split(' ')[2] || 'unassigned';
            return `${n.padEnd(23)}${ip.padEnd(16)}YES ${ip === 'unassigned' ? 'unset ' : 'manual'} ${(i.shutdown ? 'administratively down' : 'up').padEnd(22)}${i.shutdown ? 'down' : 'up'}`;
          })]);
      }
      say('% Incomplete command.'); return this.#prompt();
    }
    if (is('configure', 4) && this.mode === '#') { say('Enter configuration commands, one per line.  End with CNTL/Z.'); this.mode = 'config'; return this.#prompt(); }
    if (is('copy', 2) && this.mode === '#') {
      this.state = 'question'; this.questionThen = 'Building configuration...\r\n[OK]';
      return this.out('\r\nDestination filename [startup-config]? ');
    }
    if (is('write', 2) && this.mode === '#') { say('Building configuration...\n[OK]'); return this.#prompt(); }
    if (is('ping')) { say(`Sending 5, 100-byte ICMP Echos to ${args[0] || '?'}, timeout is 2 seconds:\n!!!!!\nSuccess rate is 100 percent (5/5)`); return this.#prompt(); }
    say('% Unknown command or computer name, or unable to find computer address');
    return this.#prompt();
  }

  #runningConfig() {
    const c = this.cfg;
    const out = ['Building configuration...', '', `Current configuration : ${1200 + c.global.length * 40} bytes`, '!',
      'version 15.2', ...c.global.filter((l) => l.startsWith('service ')), '!', `hostname ${c.hostname}`, '!',
      ...c.global.filter((l) => !l.startsWith('service ')), '!'];
    for (const [name, i] of c.interfaces) {
      out.push(`interface ${name}`, ...i.lines.map((l) => ` ${l}`));
      if (i.shutdown) out.push(' shutdown');
      out.push('!');
    }
    out.push('line con 0', ...c.lineCon.map((l) => ` ${l}`), 'line vty 0 4', ' login', '!', 'end');
    return out;
  }

  /** Prints lines, pausing on " --More-- " every (terminal length - 1) lines */
  #page(lines) {
    this.pending = [...lines];
    this.#flushPage(this.termLength > 0 ? this.termLength - 1 : Infinity);
  }
  #flushPage(n, continuation = false) {
    const chunk = this.pending.splice(0, n);
    // After " --More-- " is erased, IOS writes the next line right where the marker was
    this.out(chunk.map((l, i) => (i === 0 && continuation ? l : `\r\n${l}`)).join(''));
    if (this.pending.length) { this.state = 'more'; this.out('\r\n --More-- '); }
    else { this.state = 'exec'; this.#prompt(); }
  }
  #moreKey(ch) {
    this.out('\b'.repeat(10) + ' '.repeat(10) + '\b'.repeat(10)); // IOS erases the marker in place
    if (ch === ' ') return this.#flushPage(this.termLength - 1, true);
    if (ch === '\r') return this.#flushPage(1, true);
    this.pending = []; this.state = 'exec'; this.#prompt();
  }
}

function normalizeIface(s) {
  for (const [re, full] of IFACE_ABBR) { const m = s.match(re); if (m) return `${full}${m[1]}`; }
  return null;
}
const isIp = (s) => /^(\d{1,3})(\.\d{1,3}){3}$/.test(s || '') && s.split('.').every((n) => Number(n) <= 255);
