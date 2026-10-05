/**
 * "Virtual machines" section - reserved for Proxmox VE management
 * It is wired into the shell (sidebar, routing, keep-alive views) so the real
 * implementation only has to replace this mount() function
 */
import { h, icon } from '../../core/dom.js';

export function mount(el) {
  el.append(
    h('header.view-head', h('div.view-title', h('h1', 'Virtual machines'), h('p', 'Proxmox VE'))),
    h('div.placeholder',
      icon('vm', 'placeholder-icon'),
      h('h2', 'Proxmox VM management will live here'),
      h('p', 'Start, stop and open the console of the lab virtual machines from the same place as your routers and switches. VM consoles will open in the same terminal workspace.'),
      h('p.placeholder-note', 'Not available yet.')));
  return {};
}
