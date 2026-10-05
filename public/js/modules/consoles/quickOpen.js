/**
 * Ctrl+K / "/" palette: open any device of any lab by typing part of its
 * name, lab or port (e.g. "b5h r2", "2014")
 */
import { h, icon } from '../../core/dom.js';

export class QuickOpen {
  #items = [];
  #results = [];
  #index = 0;

  constructor({ onPick }) {
    this.onPick = onPick;
    this.input = h('input.qo-input', { type: 'search', placeholder: 'Find a device by name, lab or port', 'aria-label': 'Find a device', autocomplete: 'off', spellcheck: 'false' });
    this.list = h('ul.qo-list', { role: 'listbox' });
    this.dialog = h('dialog.quick-open', { 'aria-label': 'Find a device' },
      h('div.qo-field', icon('search'), this.input), this.list,
      h('p.qo-hint', 'Enter opens the console. Esc closes.'));
    document.body.append(this.dialog);

    this.input.addEventListener('input', () => this.#filter());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); this.#move(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); this.#move(-1); }
      if (e.key === 'Enter' && this.#results[this.#index]) { e.preventDefault(); this.#pick(this.#results[this.#index]); }
    });
    this.dialog.addEventListener('click', (e) => { if (e.target === this.dialog) this.dialog.close(); });
  }

  setLabs(labs) {
    this.#items = labs.flatMap((lab) => lab.devices.map((d) => ({
      lab, device: d,
      haystack: `${d.name} ${lab.name} ${d.target.port} ${d.target.host}`.toLowerCase(),
    })));
  }

  open() {
    this.input.value = '';
    this.#filter();
    this.dialog.showModal();
    this.input.focus();
  }

  #filter() {
    const terms = this.input.value.toLowerCase().split(/\s+/).filter(Boolean);
    this.#results = this.#items.filter((it) => terms.every((t) => it.haystack.includes(t))).slice(0, 50);
    this.#index = 0;
    this.list.replaceChildren(...this.#results.map((it, i) =>
      h('li.qo-item', { role: 'option', onclick: () => this.#pick(it), onpointermove: () => this.#select(i) },
        h('strong', it.device.name), h('span', it.lab.name), h('code', `${it.device.target.host}:${it.device.target.port}`))));
    if (!this.#results.length) this.list.append(h('li.qo-empty', 'No device matches. Try a lab name like B4B or a port like 2001.'));
    this.#select(0);
  }

  #move(step) {
    if (this.#results.length) this.#select((this.#index + step + this.#results.length) % this.#results.length);
  }

  #select(i) {
    this.#index = i;
    [...this.list.children].forEach((li, j) => li.setAttribute('aria-selected', String(i === j)));
    this.list.children[i]?.scrollIntoView({ block: 'nearest' });
  }

  #pick(item) {
    this.dialog.close();
    this.onPick(item.lab, item.device);
  }
}
