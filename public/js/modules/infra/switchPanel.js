/**
 * Admin switches tab: the four infrastructure switches. Their consoles use the
 * same jump server → telnet chain (ConsoleSession) as the lab devices and open
 * in the shared workspace
 */
import { h, icon, toast } from '../../core/dom.js';
import { getJson, live } from '../../core/api.js';
import { workspace } from '../../shared/workspace.js';
import { consoleSession } from '../../shared/sessions.js';

const STATE_TEXT = { idle: 'Free', open: 'Open in your workspace', busy: 'In use by another session', disabled: 'Not on the allow-list' };

export class SwitchPanel {
  switches = [];
  busy = new Set();
  #cards = new Map();

  constructor() {
    this.grid = h('div.switch-bays');
    this.el = h('div.panel', this.grid);
    live.on('consoles:busy', (targets) => { this.busy = new Set(targets); this.#refresh(); });
    workspace.addEventListener('change', () => this.#refresh());
  }

  async show() {
    try {
      ({ switches: this.switches } = await getJson('/api/consoles/admin-switches'));
    } catch (err) {
      this.grid.replaceChildren(h('p.form-error', err.message));
      return;
    }
    this.#render();
  }

  #render() {
    this.#cards.clear();
    if (!this.switches.length) {
      this.grid.replaceChildren(h('p.muted', 'No admin switch is listed in config/infrastructure.json.'));
      return;
    }
    const bays = Map.groupBy(this.switches, (s) => s.bay || 'Other');
    this.grid.replaceChildren(...[...bays].map(([bay, list]) => h('section.bay',
      h('h3', bay),
      h('div.bay-cards', list.map((s) => {
        const btn = h('button.btn.primary.small', { type: 'button', onclick: () => this.#open(s) }, icon('terminal'), 'Open console');
        const state = h('span.switch-state');
        const card = h('article.switch-card',
          h('span.switch-led', { 'aria-hidden': 'true' }),
          h('div.switch-text', h('strong', s.name), h('code', `${s.target.host}:${s.target.port}`), state),
          btn);
        this.#cards.set(s.key, { card, state, btn, s });
        return card;
      })))));
    this.#refresh();
  }

  #open(s) {
    const session = consoleSession(s, s.bay);
    if (!workspace.panes.has(session.key) && this.busy.has(`${s.target.host}:${s.target.port}`)) {
      return toast(`${s.labName} is in use by another session. Try again when it is free.`, 'warn');
    }
    workspace.open(session);
  }

  #refresh() {
    const mine = workspace.liveTargets();
    for (const { card, state, btn, s } of this.#cards.values()) {
      const t = `${s.target.host}:${s.target.port}`;
      const st = !s.allowed ? 'disabled' : mine.has(t) ? 'open' : this.busy.has(t) ? 'busy' : 'idle';
      card.dataset.state = st;
      state.textContent = STATE_TEXT[st];
      btn.disabled = st === 'disabled';
      btn.lastChild.textContent = st === 'open' ? 'Show console' : 'Open console';
    }
  }
}
