/**
 * Proxmox VE API client - every byte goes through the SSH jump server
 *
 * Transport
 *   Proxmox sits on the isolated lab network, so the platform never opens a
 *   TCP connection to it; Each connection is an SSH `forwardOut` channel on
 *   the shared jump-server tunnel, with TLS end-to-end to Proxmox on top:
 *
 *     https request ─► TunnelAgent.createConnection ─► tunnel.forwardOut(10.22.9.20, 8006)
 *                                                     └► tls.connect({ socket: channel })
 *     console WebSocket ─► same tunnelled TLS socket, handed to `ws` via createConnection
 *
 *   The HTTPS agent keeps sockets alive and requests are limited to 6 at a
 *   time, so a burst of API calls reuses a few channels instead of opening
 *   one per call
 *
 * Ticket lifecycle
 *   POST /access/ticket → PVEAuthCookie (every call) + CSRFPreventionToken
 *   (every write); Renewed before Proxmox's 2 h expiry, and once more on any
 *   401. Concurrent callers share a single in-flight login
 *
 * Certificate
 *   Proxmox is self-signed; With PROXMOX_FINGERPRINT set, any other
 *   certificate is refused before the request (and password) is written
 *   Without it, the connection is accepted and the observed fingerprint is
 *   logged once so it can be pinned - the same rule as SSH_HOST_FINGERPRINT
 */
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import WebSocket from 'ws';

const API = '/api2/json';

export class ProxmoxError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class ProxmoxClient {
  #ticket = null;        // { value, csrf, user, at }
  #loginInFlight = null;
  #warnedUnpinned = false;
  #active = 0;           // requests in flight
  #queue = [];           // requests waiting for a free slot

  constructor({ url, username, realm, password, fingerprint, tunnel, logger, refreshAfterMs = 90 * 60_000, timeoutMs = 30_000 }) {
    this.base = new URL(url);
    this.host = this.base.hostname;
    this.port = Number(this.base.port || 8006);
    this.userid = username.includes('@') ? username : `${username}@${realm}`;
    this.password = password;
    this.fingerprint = fingerprint ? fingerprint.toUpperCase() : null;
    this.tunnel = tunnel;
    this.log = logger;
    this.refreshAfterMs = refreshAfterMs;
    this.timeoutMs = timeoutMs;
    // At most MAX_IN_FLIGHT requests at once, over kept-alive tunnelled sockets
    // (The agent can't cap sockets itself when connections are created asynchronously)
    this.maxInFlight = 6;
    this.agent = new TunnelAgent(this, { keepAlive: true });
  }

  /** Releases pooled tunnel sockets (the shared SSH tunnel is closed by its owner) */
  close() {
    this.agent.destroy();
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, form) { return this.request('POST', path, { form }); }
  put(path, form) { return this.request('PUT', path, { form }); }

  /** Authenticated API call; Returns the `data` member of the Proxmox answer */
  async request(method, path, { query, form } = {}, retried = false) {
    const ticket = await this.#auth();
    const res = await this.#send(method, path, { query, form, ticket });
    if (res.status === 401 && !retried) {
      this.log.info('Proxmox ticket rejected, signing in again');
      this.#ticket = null;
      return this.request(method, path, { query, form }, true);
    }
    if (res.status >= 400) throw toError(res);
    return res.body?.data ?? null;
  }

  /**
   * A TLS socket to Proxmox, carried by an SSH channel through the jump server
   * Used by the HTTPS agent and, directly, by console WebSockets
   */
  async openTunnelledSocket() {
    const channel = await this.tunnel.forwardOut(this.host, this.port);
    return new Promise((resolve, reject) => {
      const socket = tls.connect({
        socket: channel,
        servername: net.isIP(this.host) ? undefined : this.host, // no SNI for IP addresses
        rejectUnauthorized: false, // self-signed: identity is checked by fingerprint below
      });
      const fail = (err) => { socket.destroy(); channel.destroy?.(); reject(err); };
      socket.once('error', fail);
      socket.once('secureConnect', () => {
        socket.removeListener('error', fail);
        const seen = socket.getPeerCertificate()?.fingerprint256?.toUpperCase();
        if (this.fingerprint && seen !== this.fingerprint) {
          return fail(new ProxmoxError(502, `Proxmox TLS fingerprint mismatch (server presented ${seen})`));
        }
        if (!this.fingerprint && !this.#warnedUnpinned) {
          this.#warnedUnpinned = true;
          this.log.warn(`PROXMOX_FINGERPRINT is not set - Proxmox identity is NOT verified. Observed: ${seen}`);
        }
        resolve(socket);
      });
    });
  }

  /**
   * Authenticated WebSocket to Proxmox (vncwebsocket, for termproxy and
   * vncproxy); The tunnelled TLS socket is injected with `createConnection`,
   * so `ws` performs its HTTP upgrade over the SSH channel
   *
   * Returned PAUSED: call ws.resume() once your 'message' listener is set
   * A VNC server speaks first, and over the SSH channel its greeting arrives
   * in the same chunk as the 101 response; ws would emit it on the next tick,
   * before any `await` continuation could listen, and it would be lost
   */
  async openWebSocket(path, query) {
    const ticket = await this.#auth();
    const socket = await this.openTunnelledSocket();
    const url = new URL(API + path, this.base);
    url.protocol = 'wss:';
    for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, String(v));
    const ws = new WebSocket(url, ['binary'], {
      createConnection: () => socket,
      headers: { Cookie: `PVEAuthCookie=${ticket.value}` },
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
    });
    await new Promise((resolve, reject) => {
      ws.once('open', () => { ws.pause(); resolve(); }); // synchronous: nothing is read before this
      ws.once('unexpected-response', (_req, res) => reject(new ProxmoxError(res.statusCode, `Proxmox refused the console connection (HTTP ${res.statusCode})`)));
      ws.once('error', (err) => reject(new ProxmoxError(502, `Console connection to Proxmox failed: ${err.message}`)));
    });
    return ws;
  }

  async #auth() {
    if (this.#ticket && Date.now() - this.#ticket.at < this.refreshAfterMs) return this.#ticket;
    this.#loginInFlight ??= this.#login().finally(() => { this.#loginInFlight = null; });
    return this.#loginInFlight;
  }

  async #login() {
    const res = await this.#send('POST', '/access/ticket', { form: { username: this.userid, password: this.password } });
    if (res.status === 401) throw new ProxmoxError(502, `Proxmox rejected the credentials of ${this.userid} (check PROXMOX_USERNAME / PROXMOX_REALM / PROXMOX_PASSWORD)`);
    if (res.status >= 400) throw toError(res);
    const d = res.body?.data;
    if (!d?.ticket || !d?.CSRFPreventionToken) throw new ProxmoxError(502, 'Unexpected answer from /access/ticket');
    this.#ticket = { value: d.ticket, csrf: d.CSRFPreventionToken, user: d.username, at: Date.now() };
    this.log.info(`Proxmox ticket obtained for ${d.username}`);
    return this.#ticket;
  }

  async #send(method, path, opts) {
    if (this.#active >= this.maxInFlight) await new Promise((resolve) => this.#queue.push(resolve));
    this.#active++;
    try {
      return await this.#sendNow(method, path, opts);
    } finally {
      this.#active--;
      this.#queue.shift()?.();
    }
  }

  #sendNow(method, path, { query, form, ticket }) {
    const url = new URL(API + path, this.base);
    for (const [k, v] of Object.entries(query || {})) if (v !== undefined) url.searchParams.set(k, String(v));
    const body = form ? new URLSearchParams(Object.entries(form).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString() : null;
    const headers = { Accept: 'application/json' };
    if (body !== null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    if (ticket) {
      headers.Cookie = `PVEAuthCookie=${ticket.value}`;
      if (method !== 'GET') headers.CSRFPreventionToken = ticket.csrf;
    }
    return new Promise((resolve, reject) => {
      const req = https.request(url, { method, headers, agent: this.agent, timeout: this.timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
          resolve({ status: res.statusCode, statusText: res.statusMessage, body: parsed });
        });
      });
      req.on('timeout', () => req.destroy(new Error(`Proxmox did not answer within ${this.timeoutMs / 1000}s`)));
      req.on('error', (err) => reject(err instanceof ProxmoxError ? err : new ProxmoxError(502, `Cannot reach Proxmox ${this.host}:${this.port} through the jump server: ${err.message}`)));
      if (body !== null) req.write(body);
      req.end();
    });
  }
}

/**
 * https.Agent whose sockets are TLS sessions inside SSH forwardOut channels
 * createConnection answers through the callback (async), which Node's HTTP
 * agent supports; with keepAlive the tunnelled sockets are pooled and reused
 */
class TunnelAgent extends https.Agent {
  constructor(client, opts) {
    super(opts);
    this.client = client;
  }

  createConnection(_options, callback) {
    this.client.openTunnelledSocket().then((socket) => callback(null, socket), callback);
    // Returning nothing tells the agent the socket arrives via the callback
  }
}

function toError(res) {
  // Parameter errors come back as { errors: { net0: "…" } } with a 400
  const details = res.body?.errors;
  const detail = details ? Object.entries(details).map(([k, v]) => `${k}: ${v}`).join('; ') : '';
  const message = [res.statusText, detail].filter(Boolean).join(' - ') || `HTTP ${res.status}`;
  return new ProxmoxError(res.status, `Proxmox: ${message}`);
}
