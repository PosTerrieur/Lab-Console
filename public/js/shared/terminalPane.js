/**
 * Text console tile: xterm.js + one WebSocket speaking the platform's console
 * protocol; Used for lab devices and admin switches (/ws/console) and for
 * Proxmox serial consoles (/ws/proxmox/serial, translated server-side)
 */
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';
import { icon, h } from '../core/dom.js';
import { BasePane } from './pane.js';

// High-contrast palette tuned for long CLI sessions; every ANSI colour,
// including "bright black" (used for dim text), stays readable on the background
const THEME = {
  background: '#0F1821',
  foreground: '#E3E9EF',
  cursor: '#7CC3F0',
  cursorAccent: '#0F1821',
  selectionBackground: 'rgba(124, 195, 240, 0.32)',
  black: '#2B3642', red: '#F07B72', green: '#7BD88F', yellow: '#F2C462',
  blue: '#73B3EC', magenta: '#D59CF0', cyan: '#6FD3DA', white: '#D6DEE6',
  brightBlack: '#8796A5', brightRed: '#FF9C94', brightGreen: '#9BE8AB', brightYellow: '#FFD884',
  brightBlue: '#97C9F5', brightMagenta: '#E3B8F5', brightCyan: '#94E4EA', brightWhite: '#FFFFFF',
};

const PHASE_TEXT = { ssh: 'Reaching jump server', telnet: 'Opening console', proxmox: 'Opening VM console', connected: 'Connected', login: 'Connected' };

export class TerminalPane extends BasePane {
  constructor(session, opts) {
    // BREAK only exists on real serial lines behind the terminal server
    const actions = session.kind === 'console'
      ? [h('button.icon-btn', { type: 'button', title: 'Send BREAK (password recovery, ROMMON)', onclick: () => this.#send({ type: 'break' }) }, icon('break'))]
      : [];
    super(session, opts, actions);

    this.term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize: opts.fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      theme: THEME,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.onData((data) => this.#send({ type: 'input', data }));
    this.term.textarea?.addEventListener('focus', () => opts.onFocus(this));
    // Ctrl+Shift+C copies the selection (Ctrl+C must stay "interrupt" for the device)
    this.term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && e.shiftKey && e.code === 'KeyC' && this.term.hasSelection()) {
        navigator.clipboard?.writeText(this.term.getSelection());
        return false;
      }
      return true;
    });
  }

  /** Called once the element is in the DOM (xterm needs real dimensions) */
  attach() {
    this.term.open(this.body);
    this.fit();
    new ResizeObserver(() => this.fit()).observe(this.body);
    this.connect();
  }

  connect() {
    this.ws?.close();
    this.setState('connecting', 'Starting…');
    this.hideEnd();
    if (this.everConnected) this.term.write('\r\n');
    this.everConnected = true;

    const ws = (this.ws = new WebSocket(this.wsUrl({ cols: this.term.cols, rows: this.term.rows })));
    ws.binaryType = 'arraybuffer';
    let ended = false;

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return this.term.write(new Uint8Array(e.data));
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') {
        const live = msg.phase === 'connected' || msg.phase === 'login';
        this.setState(live ? 'connected' : 'connecting', PHASE_TEXT[msg.phase] || msg.message);
        // Only pre-connection steps go into the scrollback; once the device talks, the terminal is its own
        if (!live) this.term.write(`\x1b[90m› ${msg.message}\x1b[0m\r\n`);
      } else if (msg.type === 'error' || msg.type === 'exit') {
        ended = true;
        this.#end(msg.type === 'error' ? 'error' : 'closed', msg.message);
      }
    };
    ws.onclose = (e) => {
      if (ended || ws !== this.ws) return;
      this.#end('closed', e.code === 1006 ? 'Connection to the platform was lost' : e.reason || 'Session closed');
    };
  }

  #end(state, message) {
    this.term.write(`\r\n\x1b[${state === 'error' ? '91' : '90'}m› ${message}\x1b[0m\r\n`);
    this.showEnd(state, message);
  }

  #send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  fit() {
    if (!this.body.isConnected || !this.body.clientWidth) return;
    cancelAnimationFrame(this.fitFrame);
    this.fitFrame = requestAnimationFrame(() => {
      try {
        const { cols, rows } = this.term;
        this.fitAddon.fit();
        if (cols !== this.term.cols || rows !== this.term.rows) this.#send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
      } catch { /* hidden pane */ }
    });
  }

  setFontSize(px) {
    this.term.options.fontSize = px;
    this.fit();
  }

  focus() { this.term.focus(); }

  dispose() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.term.dispose();
    this.el.remove();
  }
}
