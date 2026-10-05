/**
 * Virtual machines tab - a plain list of every Proxmox VM with:
 *   power (Start / Stop / Force stop), consoles (Serial / VNC),
 *   the VLAN tag of net0 (edit in place), and "Clone template"
 */
import { h, icon, toast } from '../../core/dom.js';
import { getJson, request, live } from '../../core/api.js';
import { workspace } from '../../shared/workspace.js';
import { vmSerialSession, vmScreenSession } from '../../shared/sessions.js';
import { openCloneDialog } from './dialogs.js';

export class VmPanel {
  vms = [];
  #timer = null;
  #reloadSoon = null;

  constructor({ proxmox, host, via }) {
    this.proxmox = proxmox;
    this.filter = h('input.field.filter', { type: 'search', placeholder: 'Filter by name, VM id or VLAN', 'aria-label': 'Filter virtual machines', oninput: () => this.#renderRows() });
    this.jobsEl = h('ul.jobs', { 'aria-live': 'polite' });
    this.tbody = h('tbody');
    this.foot = h('p.table-foot');
    this.el = h('div.panel',
      h('div.panel-toolbar',
        this.filter,
        host ? h('span.badge', { title: 'Proxmox is reached through the SSH jump server' }, `${host} via ${via}`) : null,
        h('button.icon-btn', { type: 'button', title: 'Reload from Proxmox', onclick: () => this.load(true) }, icon('refresh')),
        h('button.btn.primary', { type: 'button', onclick: () => this.#clone() }, icon('plus'), 'Clone template')),
      this.jobsEl,
      h('div.table-wrap', h('table.vm-table',
        h('thead', h('tr', h('th', 'VM'), h('th', 'VLAN (net0)'), h('th', 'Console'), h('th.right', 'Power'))),
        this.tbody)),
      this.foot);

    if (!proxmox) {
      this.el.replaceChildren(h('div.placeholder', icon('rack', 'placeholder-icon'),
        h('h2', 'Proxmox is not configured'),
        h('p', 'Set PROXMOX_URL, PROXMOX_USERNAME and PROXMOX_PASSWORD in .env and restart the platform.')));
      return;
    }
    live.on('proxmox:jobs', (jobs) => this.#renderJobs(jobs));
    live.on('proxmox:changed', () => {
      clearTimeout(this.#reloadSoon);
      this.#reloadSoon = setTimeout(() => this.load(), 300);
    });
  }

  show() {
    if (!this.proxmox) return;
    this.load();
    // Power state also changes outside the platform (guest shutdown): refresh while visible
    clearInterval(this.#timer);
    this.#timer = setInterval(() => { if (this.el.isConnected && !document.hidden) this.load(); else clearInterval(this.#timer); }, 15_000);
  }

  async load(manual = false) {
    if (!this.vms.length) this.tbody.replaceChildren(h('tr', h('td.empty-row', { colspan: 4 }, 'Asking Proxmox through the jump server…')));
    try {
      ({ vms: this.vms } = await getJson('/api/proxmox/vms'));
      this.#renderRows();
      if (manual) toast('VM list reloaded');
    } catch (err) {
      this.tbody.replaceChildren(h('tr', h('td.empty-row', { colspan: 4 },
        h('p.form-error', `Could not reach Proxmox: ${err.message}`),
        h('button.btn.small', { type: 'button', onclick: () => this.load(true) }, 'Try again'))));
    }
  }

  #renderRows() {
    const q = this.filter.value.trim().toLowerCase();
    const machines = this.vms.filter((v) => !v.template);
    const shown = machines.filter((v) => !q || `${v.name} ${v.vmid} ${v.vlan ?? ''}`.toLowerCase().includes(q));
    // Don't wipe a VLAN field someone is typing in during the 15 s refresh
    if (this.tbody.contains(document.activeElement) && document.activeElement.matches('input')) return;
    this.tbody.replaceChildren(...shown.map((vm) => this.#row(vm)));
    if (!shown.length) this.tbody.append(h('tr', h('td.empty-row', { colspan: 4 }, q ? 'No VM matches this filter.' : 'No VMs yet. Use Clone template to create one.')));
    const templates = this.vms.filter((v) => v.template).length;
    this.foot.textContent = `${machines.length} VMs. ${templates} template${templates === 1 ? '' : 's'} available to clone.`;
  }

  #row(vm) {
    const running = vm.status === 'running';
    const btn = (label, iconName, attrs) => h('button.btn.small', { type: 'button', 'aria-label': `${label} ${vm.name}`, ...attrs }, icon(iconName), h('span.lbl', label));

    const consoles = [
      btn('Serial', 'terminal', {
        disabled: !running || !vm.hasSerial,
        title: !vm.hasSerial ? 'No serial port on this VM (add serial0: socket in Proxmox)' : running ? 'Text console in the workspace' : 'Start the VM first',
        onclick: () => workspace.open(vmSerialSession(vm)),
      }),
      btn('VNC', 'screen', {
        disabled: !running,
        title: running ? 'Graphical console in the workspace' : 'Start the VM first',
        onclick: () => workspace.open(vmScreenSession(vm)),
      }),
    ];
    const power = running
      ? [btn('Stop', 'power', { title: 'Shut down the guest cleanly (ACPI)', onclick: () => this.#power(vm, 'stop') }),
        btn('Force stop', 'close', { class: 'btn small danger', title: 'Cut the power immediately', onclick: () => this.#power(vm, 'force-stop') })]
      : [btn('Start', 'play', { title: 'Start the VM', onclick: () => this.#power(vm, 'start') })];

    return h('tr', { dataset: { status: vm.status } },
      h('td', h('div.vm-cell',
        h('span.vm-led', { title: vm.status }),
        h('div', h('strong', vm.name), h('span.vm-meta', `${vm.vmid} on ${vm.node}`)))),
      h('td', vm.bridge ? this.#vlanEditor(vm) : h('span.muted', 'no net0')),
      h('td', h('div.row-actions', consoles)),
      h('td.right', h('div.row-actions.end', power)));
  }

  /** net0 VLAN tag, edited in place: type a number (empty = untagged), Enter or Set */
  #vlanEditor(vm) {
    const input = h('input.field.vlan-input', {
      type: 'number', min: 1, max: 4094, placeholder: 'none', value: vm.vlan ?? '',
      'aria-label': `VLAN tag of ${vm.name} net0`, title: `net0 on ${vm.bridge}. Empty = untagged.`,
    });
    const set = h('button.btn.small.primary', { type: 'button', hidden: true }, 'Set');
    const dirty = () => input.value !== String(vm.vlan ?? '');
    input.addEventListener('input', () => { set.hidden = !dirty(); });
    const save = async () => {
      if (!dirty()) return;
      const vlan = input.value === '' ? null : Number(input.value);
      set.disabled = true;
      try {
        await request('PUT', `/api/proxmox/vms/${vm.node}/${vm.vmid}/vlan`, { vlan });
        vm.vlan = vlan;
        set.hidden = true;
        toast(`${vm.name} net0 is now ${vlan === null ? 'untagged' : `on VLAN ${vlan}`}`);
        input.blur();
      } catch (err) {
        toast(err.message, 'error');
      } finally { set.disabled = false; }
    };
    set.addEventListener('click', save);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') save();
      if (e.key === 'Escape') { input.value = vm.vlan ?? ''; set.hidden = true; input.blur(); }
    });
    return h('div.vlan-edit', input, set);
  }

  async #power(vm, action) {
    if (action === 'force-stop' && !confirm(`Force stop ${vm.name}? This is like pulling the power cable.`)) return;
    try {
      await request('POST', `/api/proxmox/vms/${vm.node}/${vm.vmid}/power`, { action });
      toast(`${vm.name}: ${{ start: 'starting', stop: 'shutting down', 'force-stop': 'force-stopping' }[action]}`);
    } catch (err) { toast(err.message, 'error'); }
  }

  async #clone() {
    const templates = this.vms.filter((v) => v.template);
    if (!templates.length) return toast('No template found. Convert a VM to a template in Proxmox first.', 'warn');
    const { nodes } = await getJson('/api/proxmox/nodes').catch(() => ({ nodes: [] }));
    openCloneDialog({ templates, nodes });
  }

  #renderJobs(jobs) {
    this.jobsEl.replaceChildren(...jobs.map((j) => h(`li.job.${j.state}`,
      j.state === 'running' ? h('span.spinner', { 'aria-hidden': 'true' }) : icon(j.state === 'done' ? 'check' : 'warning'),
      h('strong', j.label), h('span', j.message))));
  }
}
