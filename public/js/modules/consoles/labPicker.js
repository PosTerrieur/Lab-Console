/**
 * Lab selector drawn as rack elevations
 *
 * Page names like "B4H / B4M / B4B" read as bay 4, top/middle/bottom
 * (Haut/Milieu/Bas), so they are shown stacked the way they sit in the room
 * A missing position becomes a blanking panel
 * Any naming that doesn't follow that pattern falls back to plain tabs
 */
import { h } from '../../core/dom.js';

const POSITION = /^(.*?\d+)\s*[-_ ]?\s*([HMB])$/i;
const ORDER = ['H', 'M', 'B'];

export class LabPicker {
  #buttons = new Map();

  constructor(container, { onSelect }) {
    this.onSelect = onSelect;
    this.el = h('nav.lab-picker', { 'aria-label': 'Labs' });
    container.append(this.el);
  }

  render(labs) {
    this.#buttons.clear();
    const parsed = labs.map((lab) => ({ lab, m: lab.name.match(POSITION) }));
    const asRacks = parsed.length > 1 && parsed.every((p) => p.m);
    this.el.classList.toggle('as-racks', asRacks);

    if (!asRacks) {
      this.el.replaceChildren(h('div.lab-tabs', labs.map((lab) => this.#button(lab, 'lab-tab'))));
      return;
    }
    const bays = new Map();
    for (const { lab, m } of parsed) {
      const bay = m[1].toUpperCase();
      if (!bays.has(bay)) bays.set(bay, {});
      bays.get(bay)[m[2].toUpperCase()] = lab;
    }
    this.el.replaceChildren(...[...bays].map(([bay, slots]) =>
      h('div.rack', { role: 'group', 'aria-label': `Bay ${bay}` },
        h('span.rack-plate', bay),
        ORDER.map((pos) => slots[pos] ? this.#button(slots[pos], 'rack-slot') : h('span.rack-slot.blank', { 'aria-hidden': 'true' })))));
  }

  #button(lab, cls) {
    const b = h(`button.${cls}`, { type: 'button', onclick: () => this.onSelect(lab), title: `${lab.name}: ${lab.devices.length} devices` },
      h('span.slot-led', { 'aria-hidden': 'true' }), h('span', lab.name));
    this.#buttons.set(lab.id, b);
    return b;
  }

  setActive(labId) {
    for (const [id, b] of this.#buttons) {
      b.classList.toggle('active', id === labId);
      b.setAttribute('aria-current', id === labId ? 'page' : 'false');
    }
  }

  /** Light the slot LED of labs that have a console open in this browser */
  setLive(labIds) {
    for (const [id, b] of this.#buttons) b.classList.toggle('live', labIds.has(id));
  }
}
