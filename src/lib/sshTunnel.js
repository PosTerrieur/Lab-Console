/**
 * A single, shared SSH connection to the jump server used as a TCP tunnel
 * into the isolated lab network (Proxmox API + console WebSockets)
 *
 *   platform ──SSH──► jump server ──TCP (direct-tcpip)──► 10.22.9.20:8006
 *
 * - One SSH connection for everything: each HTTPS request or console
 *   WebSocket is just a lightweight `forwardOut` channel on it. (Lab consoles
 *   keep their own SSH connection per terminal: an exec session each)
 * - Opened lazily on first use, shared by concurrent callers (one in-flight
 *   connect), kept alive with SSH keepalives, and transparently re-opened if
 *   the jump server drops it
 * - Requires the jump server's sshd to allow TCP forwarding
 *   (AllowTcpForwarding yes - the OpenSSH default); It can be narrowed with
 *   `PermitOpen 10.22.9.71:8006` in a Match block for the jump account
 */
import { Client } from 'ssh2';
import { sshConnectOptions, describeSshError } from './ssh.js';

export class SshTunnel {
  #conn = null;
  #connecting = null;
  #channels = 0;

  constructor({ ssh, logger }) {
    this.ssh = ssh;
    this.log = logger;
  }

  /** Opens a TCP stream to host:port as seen from the jump server */
  async forwardOut(host, port) {
    try {
      return await this.#forward(await this.#connection(), host, port);
    } catch (err) {
      // The shared connection may have died between two calls: retry once on a fresh one
      if (err.retryable) {
        this.#drop();
        return this.#forward(await this.#connection(), host, port);
      }
      throw err;
    }
  }

  get state() {
    return { connected: Boolean(this.#conn), openChannels: this.#channels };
  }

  close() {
    this.#drop();
  }

  #forward(conn, host, port) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        conn.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
          settled = true;
          if (err) {
            // "Connection refused"/"administratively prohibited" come from the jump server itself
            const e = new Error(`Jump server could not open ${host}:${port}: ${err.message}`);
            e.retryable = /not connected|no response|closed/i.test(err.message);
            return reject(e);
          }
          this.#channels++;
          stream.once('close', () => { this.#channels--; });
          resolve(stream);
        });
      } catch (err) {
        if (!settled) reject(Object.assign(new Error(err.message), { retryable: true }));
      }
    });
  }

  #connection() {
    if (this.#conn) return Promise.resolve(this.#conn);
    this.#connecting ??= new Promise((resolve, reject) => {
      const conn = new Client();
      conn.once('ready', () => {
        this.#conn = conn;
        this.#connecting = null;
        this.log.info(`SSH tunnel to ${this.ssh.host} is up`);
        resolve(conn);
      });
      conn.once('error', (err) => {
        if (this.#conn !== conn) { // failed while connecting
          this.#connecting = null;
          reject(new Error(describeSshError(err, this.ssh)));
        } else {
          this.log.warn(`SSH tunnel error: ${err.message}`);
        }
      });
      conn.once('close', () => {
        if (this.#conn === conn) {
          this.#conn = null;
          this.log.info('SSH tunnel closed; it will reopen on next use');
        }
      });
      conn.connect(sshConnectOptions(this.ssh, this.log));
    });
    return this.#connecting;
  }

  #drop() {
    const c = this.#conn;
    this.#conn = null;
    try { c?.end(); } catch { /* ignore */ }
  }
}
