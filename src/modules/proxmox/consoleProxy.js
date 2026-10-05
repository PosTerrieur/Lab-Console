/**
 * Browser ⇄ platform ⇄ Proxmox console bridges
 *
 * The browser never talks to Proxmox and never holds a Proxmox credential:
 * the platform asks Proxmox for a one-time console ticket, opens the
 * `vncwebsocket` itself with its PVEAuthCookie, and relays
 *
 * SERIAL  (/ws/proxmox/serial) - Proxmox `termproxy` speaks a small framing
 *   protocol (pve-xtermjs): first frame "<user>:<ticket>\n", answer "OK",
 *   then "0:<bytes>:<data>" for keystrokes, "1:<cols>:<rows>:" for resize,
 *   "2" as keep-alive; It is translated into the platform's own console
 *   protocol, so the browser reuses the exact same TerminalPane/xterm.js as
 *   the lab consoles
 *
 * VNC     (/ws/proxmox/vnc) - raw RFB for noVNC; Proxmox protects the VNC
 *   server with "VNC authentication" whose password is the console ticket
 *   Instead of shipping that ticket to the browser, the proxy completes the
 *   RFB handshake + DES challenge with Proxmox itself, then offers the
 *   browser a "None" security type and splices the two streams
 */
import { DESECBCipher } from '../../../node_modules/@novnc/novnc/core/crypto/des.js';

// ─── Serial (termproxy ⇄ platform console protocol) ─────────────────────────

export async function bridgeSerial({ service, client, node, vmid, cols, rows, browser, log }) {
  const send = (msg) => browser.readyState === browser.OPEN && browser.send(JSON.stringify(msg));
  send({ type: 'status', phase: 'proxmox', message: 'Asking Proxmox for a serial console…' });

  const t = await service.openTermProxy(node, vmid);
  const upstream = await client.openWebSocket(`/nodes/${t.vm.node}/qemu/${t.vm.vmid}/vncwebsocket`, { port: t.port, vncticket: t.ticket });
  if (browser.readyState !== browser.OPEN) return upstream.close(); // tab closed while we were connecting
  upstream.send(`${t.user}:${t.ticket}\n`);

  let authed = false;
  let ended = false;
  const end = (message) => {
    if (ended) return;
    ended = true;
    clearInterval(keepAlive);
    send({ type: 'exit', message });
    try { upstream.close(); } catch { /* ignore */ }
    if (browser.readyState === browser.OPEN) browser.close(1000, 'session ended');
  };
  const keepAlive = setInterval(() => upstream.readyState === upstream.OPEN && upstream.send('2'), 30_000);
  const resize = (c, r) => {
    if (Number.isInteger(c) && Number.isInteger(r) && c > 0 && r > 0 && c < 1000 && r < 1000) upstream.send(`1:${c}:${r}:`);
  };

  upstream.on('message', (data) => {
    let buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    if (!authed) {
      if (buf.subarray(0, 2).toString() !== 'OK') return end('Proxmox refused the serial console ticket');
      authed = true;
      buf = buf.subarray(2);
      send({ type: 'status', phase: 'connected', message: `Serial console of ${t.vm.name}` });
      resize(cols, rows);
      // Serial consoles are silent until a key is pressed: nudge once so the login prompt shows
      upstream.send('0:1:\r');
    }
    if (buf.length && browser.readyState === browser.OPEN) browser.send(buf, { binary: true });
  });
  upstream.resume(); // listener attached: let Proxmox's frames flow (see client.openWebSocket)
  upstream.on('close', () => end(`Serial console of ${t.vm.name} closed`));
  upstream.on('error', (err) => end(`Proxmox console error: ${err.message}`));

  browser.on('message', (raw, isBinary) => {
    if (isBinary || !authed) return;
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'input' && typeof msg.data === 'string' && msg.data) {
      upstream.send(`0:${Buffer.byteLength(msg.data)}:${msg.data}`);
    } else if (msg.type === 'resize') {
      resize(Number(msg.cols), Number(msg.rows));
    }
  });
  browser.on('close', () => end('Browser disconnected'));
  log.info(`serial console opened: ${t.vm.name} (${t.vm.vmid})`);
}

// ─── VNC (authenticating RFB relay for noVNC) ───────────────────────────────

const RFB_VERSION = Buffer.from('RFB 003.008\n');

export async function bridgeVnc({ service, client, node, vmid, browser, log }) {
  const t = await service.openVncProxy(node, vmid);
  const upstream = await client.openWebSocket(`/nodes/${t.vm.node}/qemu/${t.vm.vmid}/vncwebsocket`, { port: t.port, vncticket: t.ticket });
  if (browser.readyState !== browser.OPEN) return upstream.close(); // tab closed while we were connecting
  const up = new ByteReader(upstream);
  upstream.resume(); // the RFB greeting was held back until this reader existed
  const down = new ByteReader(browser);
  try {
    // 1. Authenticate to Proxmox's VNC server as noVNC would, with the ticket as password
    const version = (await up.read(12)).toString();
    if (!version.startsWith('RFB 003.')) throw new Error(`unexpected VNC greeting ${JSON.stringify(version)}`);
    upstream.send(RFB_VERSION);
    const count = (await up.read(1))[0];
    if (count === 0) throw new Error(await readReason(up));
    const types = [...(await up.read(count))];
    if (types.includes(1)) {
      upstream.send(Buffer.from([1]));
    } else if (types.includes(2)) {
      upstream.send(Buffer.from([2]));
      const challenge = await up.read(16);
      upstream.send(vncAuthResponse(t.password ?? t.ticket, challenge));
    } else {
      throw new Error(`no supported VNC security type (server offers ${types.join(', ')})`);
    }
    if ((await up.read(4)).readUInt32BE(0) !== 0) throw new Error(`VNC authentication failed: ${await readReason(up)}`);

    // 2. Offer the browser an already-authenticated session ("None" security)
    browser.send(RFB_VERSION);
    await down.read(12);
    browser.send(Buffer.from([1, 1]));
    if ((await down.read(1))[0] !== 1) throw new Error('browser chose an unexpected security type');
    browser.send(Buffer.from([0, 0, 0, 0]));
  } catch (err) {
    up.detach(); down.detach();
    try { upstream.close(); } catch { /* ignore */ }
    browser.close(1011, 'vnc handshake failed');
    throw err;
  }

  // 3. Splice: from now on both sides speak plain RFB to each other
  const restUp = up.detach();
  const restDown = down.detach();
  if (restUp.length) browser.send(restUp, { binary: true });
  if (restDown.length) upstream.send(restDown, { binary: true });
  upstream.on('message', (d) => browser.readyState === browser.OPEN && browser.send(d, { binary: true }));
  browser.on('message', (d) => upstream.readyState === upstream.OPEN && upstream.send(d, { binary: true }));
  const closeBoth = () => { try { upstream.close(); } catch { /* */ } try { browser.close(); } catch { /* */ } };
  upstream.on('close', closeBoth);
  browser.on('close', closeBoth);
  log.info(`VNC console opened: ${t.vm.name} (${t.vm.vmid})`);
}

/** Standard VNC authentication: DES-encrypt the challenge with the (8-char) password */
export function vncAuthResponse(password, challenge) {
  const key = Array.from(String(password).slice(0, 8).padEnd(8, '\0'), (c) => c.charCodeAt(0) & 0xff);
  return Buffer.from(DESECBCipher.importKey(key).encrypt({ name: 'DES-ECB' }, [...challenge]));
}

async function readReason(reader) {
  try {
    const len = (await reader.read(4)).readUInt32BE(0);
    return (await reader.read(Math.min(len, 1024))).toString();
  } catch { return 'no reason given'; }
}

/** Turns a WebSocket's message stream into "read exactly n bytes" calls */
class ByteReader {
  #buf = Buffer.alloc(0);
  #waiter = null;

  constructor(ws, timeoutMs = 15_000) {
    this.ws = ws;
    this.timeoutMs = timeoutMs;
    this.onMessage = (d) => { this.#buf = Buffer.concat([this.#buf, Buffer.isBuffer(d) ? d : Buffer.from(d)]); this.#wake(); };
    this.onClose = () => this.#waiter?.reject(new Error('connection closed during VNC handshake'));
    ws.on('message', this.onMessage);
    ws.on('close', this.onClose);
  }

  read(n) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('VNC handshake timed out')), this.timeoutMs);
      this.#waiter = {
        n,
        resolve: (b) => { clearTimeout(timer); resolve(b); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.#wake();
    });
  }

  #wake() {
    const w = this.#waiter;
    if (w && this.#buf.length >= w.n) {
      this.#waiter = null;
      const out = this.#buf.subarray(0, w.n);
      this.#buf = this.#buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }

  /** Stop listening; returns whatever arrived beyond the handshake */
  detach() {
    this.ws.off('message', this.onMessage);
    this.ws.off('close', this.onClose);
    return this.#buf;
  }
}
