/**
 * "Infrastructure" section: Proxmox VMs and admin switches, next to the same
 * shared terminal workspace as the lab consoles
 *
 * Routes: #/infra/vms · #/infra/switches
 */
import { h } from '../../core/dom.js';
import { getJson } from '../../core/api.js';
import { SplitView } from '../../shared/splitView.js';
import { VmPanel } from './vmPanel.js';
import { SwitchPanel } from './switchPanel.js';

const TABS = [
  { id: 'vms', label: 'Virtual machines' },
  { id: 'switches', label: 'Admin switches' },
];

export function mount(el, { navigate }) {
  let tab = 'vms';
  const tabBtns = Object.fromEntries(TABS.map((t) => [t.id,
    h('button.seg-btn', { type: 'button', role: 'tab', onclick: () => select(t.id) }, t.label)]));
  el.append(h('header.view-head',
    h('div.view-title', h('h1', 'Infrastructure'), h('p', 'Proxmox VMs and admin switches')),
    h('div.seg', { role: 'tablist', 'aria-label': 'Infrastructure' }, Object.values(tabBtns))));

  const primary = h('div.infra-primary');
  const split = new SplitView(el, primary, { label: 'Infrastructure' });
  const panels = { vms: null, switches: new SwitchPanel() };

  // The VM panel needs to know whether Proxmox is configured (and how it is reached)
  getJson('/api/proxmox/status')
    .catch(() => ({ proxmox: false }))
    .then((status) => { panels.vms = new VmPanel(status); render(); });

  function select(id) {
    tab = id;
    navigate(`#/infra/${id}`);
    render();
  }

  function render() {
    for (const [id, b] of Object.entries(tabBtns)) b.setAttribute('aria-selected', String(id === tab));
    const panel = panels[tab];
    if (!panel) return;
    primary.replaceChildren(panel.el);
    panel.show();
  }

  render();

  return {
    show([sub] = []) {
      if (sub && TABS.some((t) => t.id === sub) && sub !== tab) { tab = sub; render(); }
      split.activate();
    },
  };
}
