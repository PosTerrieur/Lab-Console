/**
 * Terminal workspace: tiles every open console so several devices can be
 * configured at the same time
 *
 * Layouts: "grid" (auto rows/columns from the available width), "columns"
 * (all side by side) and "rows" (stacked); Any tile can be maximized
 * temporarily; the others stay connected in the background
 */
import { h, icon, prefs } from '../../core/dom.js';
import { TerminalPane } from './terminalPane.js';

const MIN_TILE_WIDTH = 520; // px — keeps ~70 columns of CLI readable

export class Workspace {
  panes = new Map(); // device.key → TerminalPane
  #active = null;
  #maximized = null;

  constructor(container, { onChange, onToggleDiagram }) {
    this.onChange = onChange;
    this.layout = prefs.get('layout', 'grid');
    this.fontSize = prefs.get('fontSize', 14);

    this.countLabel = h('span.ws-count');
    this.layoutBtns = Object.fromEntries(['grid', 'columns', 'rows'].map((l) => [l,
      h('button.icon-btn', { type: 'button', title: `${l[0].toUpperCase()}${l.slice(1)} layout`, 'aria-pressed': String(l === this.layout), onclick: () => this.setLayout(l) }, icon(l))]));
    this.tiles = h('div.ws-tiles', { dataset: { layout: this.layout } });

    this.el = h('section.workspace', { 'aria-label': 'Open consoles' },
      h('div.ws-toolbar',
        h('button.icon-btn', { type: 'button', title: 'Show or hide the diagram', onclick: onToggleDiagram }, icon('sidebar')),
        this.countLabel,
        h('div.ws-group', { role: 'group', 'aria-label': 'Layout' }, Object.values(this.layoutBtns)),
        h('div.ws-group.ws-text-size', { role: 'group', 'aria-label': 'Text size' },
          h('button.icon-btn', { type: 'button', title: 'Smaller text', onclick: () => this.setFontSize(this.fontSize - 1) }, icon('textSmaller')),
          h('button.icon-btn', { type: 'button', title: 'Larger text', onclick: () => this.setFontSize(this.fontSize + 1) }, icon('textLarger'))),
        h('button.btn.subtle', { type: 'button', onclick: () => this.closeAll() }, 'Close all')),
      this.tiles);
    container.append(this.el);
    new ResizeObserver(() => this.#arrange()).observe(this.tiles);
  }

  open(device) {
    const existing = this.panes.get(device.key);
    if (existing) {
      if (this.#maximized && this.#maximized !== existing) this.toggleMaximize(this.#maximized);
      this.#focus(existing);
      existing.el.classList.remove('flash');
      void existing.el.offsetWidth;
      existing.el.classList.add('flash');
      return existing;
    }
    if (this.#maximized) this.toggleMaximize(this.#maximized);
    const pane = new TerminalPane(device, {
      fontSize: this.fontSize,
      onClose: (p) => this.close(p.device.key),
      onFocus: (p) => this.#focus(p, false),
      onMaximize: (p) => this.toggleMaximize(p),
      onStateChange: () => this.onChange(),
    });
    this.panes.set(device.key, pane);
    this.tiles.append(pane.el);
    this.#arrange();
    pane.attach();
    this.#focus(pane);
    this.onChange();
    return pane;
  }

  close(key) {
    const pane = this.panes.get(key);
    if (!pane) return;
    if (this.#maximized === pane) this.#maximized = null;
    pane.dispose();
    this.panes.delete(key);
    if (this.#active === pane) {
      this.#active = null;
      const next = [...this.panes.values()].at(-1);
      if (next) this.#focus(next);
    }
    this.#arrange();
    this.onChange();
  }

  closeAll() {
    for (const key of [...this.panes.keys()]) this.close(key);
  }

  toggleMaximize(pane) {
    const on = this.#maximized !== pane;
    if (this.#maximized) this.#maximized.setMaximized(false);
    this.#maximized = on ? pane : null;
    pane.setMaximized(on);
    this.tiles.classList.toggle('has-max', on);
    for (const p of this.panes.values()) p.el.classList.toggle('maximized', p === this.#maximized);
    this.#arrange();
    this.#focus(pane);
  }

  setLayout(layout) {
    this.layout = layout;
    prefs.set('layout', layout);
    this.tiles.dataset.layout = layout;
    for (const [l, b] of Object.entries(this.layoutBtns)) b.setAttribute('aria-pressed', String(l === layout));
    this.#arrange();
  }

  setFontSize(px) {
    this.fontSize = Math.max(10, Math.min(24, px));
    prefs.set('fontSize', this.fontSize);
    for (const p of this.panes.values()) p.setFontSize(this.fontSize);
  }

  refit() {
    for (const p of this.panes.values()) p.fit();
  }

  #focus(pane, moveFocus = true) {
    if (this.#active !== pane) {
      this.#active?.el.classList.remove('active');
      this.#active = pane;
      pane.el.classList.add('active');
    }
    if (moveFocus) pane.focus();
  }

  /** Computes the grid for the current layout and tile count */
  #arrange() {
    const n = this.panes.size;
    this.countLabel.textContent = n === 1 ? '1 console open' : `${n} consoles open`;
    this.el.classList.toggle('empty', n === 0);
    if (!n) return;

    let cols;
    if (this.#maximized) cols = 1;
    else if (this.layout === 'columns') cols = n;
    else if (this.layout === 'rows') cols = 1;
    else cols = Math.max(1, Math.min(n, Math.floor(this.tiles.clientWidth / MIN_TILE_WIDTH) || 1, Math.ceil(Math.sqrt(n))));
    const rows = this.#maximized ? 1 : Math.ceil(n / cols);
    this.tiles.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
    this.tiles.style.gridTemplateRows = `repeat(${rows}, minmax(0, 1fr))`;

    // The last tile stretches across any empty cells of the final row
    const panes = [...this.panes.values()];
    const spare = cols * rows - n;
    panes.forEach((p, i) => { p.el.style.gridColumn = !this.#maximized && i === n - 1 && spare ? `span ${spare + 1}` : ''; });
    this.refit();
  }
}
