/**
 * One console tile: header + xterm.js terminal + its own WebSocket
 * Each pane is fully independent, so any number can run side by side
 */
import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/xterm-addon-fit/lib/addon-fit.mjs';
import { h, icon } from '../../core/dom.js';

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

const PHASE_TEXT = { ssh: 'Reaching jump server', telnet: 'Opening console', connected: 'Connected', login: 'Connected', closed: 'Disconnected', error: 'Could not connect' };

export class TerminalPane {
  constructor(device, { fontSize, onClose, onFocus, onMaximize, onStateChange }) {
    this.device = device;
    this.callbacks = { onClose, onFocus, onMaximize, onStateChange };
    this.state = 'connecting';

    this.statusText = h('span.pane-status', 'Starting…');
    this.reconnectBtn = h('button.icon-btn', { type: 'button', title: 'Reconnect', hidden: true, onclick: () => this.connect() }, icon('reconnect'));
    this.maxBtn = h('button.icon-btn', { type: 'button', title: 'Maximize', onclick: () => onMaximize(this) }, icon('maximize'));
    this.banner = h('div.pane-banner', { hidden: true });
    this.body = h('div.pane-body');

    this.el = h('article.pane', { dataset: { state: 'connecting' }, 'aria-label': `Console of ${device.name}` },
      h('header.pane-head',
        h('span.pane-led', { 'aria-hidden': 'true' }),
        h('div.pane-title',
          h('strong', device.name),
          h('span.pane-meta', h('span', device.labName), h('code', `${device.target.host}:${device.target.port}`))),
        this.statusText,
        h('div.pane-actions',
          h('button.icon-btn', { type: 'button', title: 'Send BREAK (password recovery, ROMMON)', onclick: () => this.#send({ type: 'break' }) }, icon('break')),
          this.reconnectBtn,
          this.maxBtn,
          h('button.icon-btn', { type: 'button', title: 'Disconnect and close', onclick: () => onClose(this) }, icon('close')))),
      h('div.pane-term', this.body, this.banner));

    this.el.addEventListener('pointerdown', () => onFocus(this));

    this.term = new Terminal({
      fontFamily: '"IBM Plex Mono", ui-monospace, Menlo, Consolas, monospace',
      fontSize,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 5000,
      allowProposedApi: false,
      theme: THEME,
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.onData((data) => this.#send({ type: 'input', data }));
    this.term.textarea?.addEventListener('focus', () => onFocus(this));
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
    this.#setState('connecting', 'Starting…');
    this.banner.hidden = true;
    this.reconnectBtn.hidden = true;
    if (this.everConnected) this.term.write('\r\n');
    this.everConnected = true;

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ device: this.device.key, cols: this.term.cols, rows: this.term.rows });
    const ws = (this.ws = new WebSocket(`${proto}://${location.host}/ws/console?${q}`));
    ws.binaryType = 'arraybuffer';
    let ended = false;

    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') return this.term.write(new Uint8Array(e.data));
      const msg = JSON.parse(e.data);
      if (msg.type === 'status') {
        this.#setState(msg.phase === 'connected' || msg.phase === 'login' ? 'connected' : 'connecting', PHASE_TEXT[msg.phase] || msg.message);
        // Only pre-connection steps go into the scrollback; once the device talks, the terminal is its own
        if (msg.phase === 'ssh' || msg.phase === 'telnet') this.term.write(`\x1b[90m› ${msg.message}\x1b[0m\r\n`);
      } else if (msg.type === 'error') {
        ended = true;
        this.#end('error', msg.message);
      } else if (msg.type === 'exit') {
        ended = true;
        this.#end('closed', msg.message);
      }
    };
    ws.onclose = () => { if (!ended && ws === this.ws) this.#end('closed', 'Connection to the platform was lost'); };
  }

  #end(state, message) {
    this.#setState(state, PHASE_TEXT[state]);
    this.term.write(`\r\n\x1b[${state === 'error' ? '91' : '90'}m› ${message}\x1b[0m\r\n`);
    this.banner.replaceChildren(
      h('p', message),
      h('div.banner-actions',
        h('button.btn.primary', { type: 'button', onclick: () => this.connect() }, state === 'error' ? 'Try again' : 'Reconnect'),
        h('button.btn', { type: 'button', onclick: () => this.callbacks.onClose(this) }, 'Close')));
    this.banner.dataset.kind = state;
    this.banner.hidden = false;
    this.reconnectBtn.hidden = false;
  }

  #setState(state, text) {
    this.state = state;
    this.el.dataset.state = state;
    this.statusText.textContent = text;
    this.callbacks.onStateChange?.(this);
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

  setMaximized(on) {
    this.maxBtn.replaceChildren(icon(on ? 'restore' : 'maximize'));
    this.maxBtn.title = on ? 'Restore layout' : 'Maximize';
  }

  focus() { this.term.focus(); }

  dispose() {
    if (this.ws) { this.ws.onclose = null; this.ws.close(); }
    this.term.dispose();
    this.el.remove();
  }
}
