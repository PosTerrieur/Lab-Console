/**
 * Common chrome for every tile of the workspace: header (LED, title, meta,
 * status, actions), focus handling, the end-of-session banner and the state
 * machine connecting → connected → closed | error
 *
 * A *session descriptor* says what a tile shows and where it connects:
 *   { key, kind: 'console' | 'serial' | 'vnc', title, subtitle, address,
 *     ws: { path, query }, target? }
 * Subclasses (TerminalPane, VncPane) implement connect(), fit(), focus(), dispose()
 */
import { h, icon } from '../core/dom.js';

export class BasePane {
  constructor(session, { onClose, onFocus, onMaximize, onStateChange }, extraActions = []) {
    this.session = session;
    this.callbacks = { onClose, onFocus, onMaximize, onStateChange };
    this.state = 'connecting';

    this.statusText = h('span.pane-status', 'Starting…');
    this.reconnectBtn = h('button.icon-btn', { type: 'button', title: 'Reconnect', hidden: true, onclick: () => this.connect() }, icon('reconnect'));
    this.maxBtn = h('button.icon-btn', { type: 'button', title: 'Maximize', onclick: () => onMaximize(this) }, icon('maximize'));
    this.banner = h('div.pane-banner', { hidden: true });
    this.body = h('div.pane-body');

    this.el = h(`article.pane.pane-${session.kind}`, { dataset: { state: 'connecting' }, 'aria-label': `${session.subtitle || 'Console'} of ${session.title}` },
      h('header.pane-head',
        h('span.pane-led', { 'aria-hidden': 'true' }),
        h('div.pane-title',
          h('strong', session.title),
          h('span.pane-meta', session.subtitle ? h('span', session.subtitle) : null, session.address ? h('code', session.address) : null)),
        this.statusText,
        h('div.pane-actions', ...extraActions, this.reconnectBtn, this.maxBtn,
          h('button.icon-btn', { type: 'button', title: 'Disconnect and close', onclick: () => onClose(this) }, icon('close')))),
      h('div.pane-term', this.body, this.banner));
    this.el.addEventListener('pointerdown', () => onFocus(this));
  }

  /** ws(s)://host/path?query for this session */
  wsUrl(extra = {}) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const q = new URLSearchParams({ ...this.session.ws.query, ...extra });
    return `${proto}://${location.host}${this.session.ws.path}?${q}`;
  }

  setState(state, text) {
    this.state = state;
    this.el.dataset.state = state;
    this.statusText.textContent = text;
    this.callbacks.onStateChange?.(this);
  }

  /** Session over: show why, offer Reconnect / Close */
  showEnd(state, message) {
    this.setState(state, state === 'error' ? 'Could not connect' : 'Disconnected');
    this.banner.replaceChildren(
      h('p', message),
      h('div.banner-actions',
        h('button.btn.primary', { type: 'button', onclick: () => this.connect() }, state === 'error' ? 'Try again' : 'Reconnect'),
        h('button.btn', { type: 'button', onclick: () => this.callbacks.onClose(this) }, 'Close')));
    this.banner.dataset.kind = state;
    this.banner.hidden = false;
    this.reconnectBtn.hidden = false;
  }

  hideEnd() {
    this.banner.hidden = true;
    this.reconnectBtn.hidden = true;
  }

  setMaximized(on) {
    this.maxBtn.replaceChildren(icon(on ? 'restore' : 'maximize'));
    this.maxBtn.title = on ? 'Restore layout' : 'Maximize';
  }

  setFontSize() {}
}
