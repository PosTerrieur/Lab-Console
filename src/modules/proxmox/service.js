/**
 * Proxmox operations used by the platform, kept deliberately small: the labs
 * only spawn lightweight "VPC" VMs for ping tests
 *
 *   - list every QEMU VM (templates flagged, used as clone sources)
 *   - power: start / stop (graceful ACPI shutdown) / force stop
 *   - change the VLAN tag of net0 (MAC and other NIC options untouched)
 *   - clone a template (name, node, VLAN), as a background job with live progress
 *   - serial / VNC console tickets for the WebSocket bridges
 */
import crypto from 'node:crypto';
import { parseNet, setNetTag } from './netconfig.js';
import { ProxmoxError } from './client.js';

const NODE_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/;
const NAME_RE = /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
// UI action → Proxmox endpoint; "Stop" asks the guest to shut down; "Force stop" pulls the plug
const POWER = { start: 'start', stop: 'shutdown', 'force-stop': 'stop' };

export class ProxmoxService {
  #cache = { at: 0, list: null };
  #jobs = new Map();

  constructor({ client, events, logger, taskPollMs = 1500 }) {
    this.pve = client;
    this.taskPollMs = taskPollMs;
    this.events = events;
    this.log = logger;
  }

  /** All QEMU VMs, with net0 and serial-port info (one config call per VM, 6 at a time) */
  async listVms({ fresh = false } = {}) {
    if (!fresh && this.#cache.list && Date.now() - this.#cache.at < 4000) return this.#cache.list;
    const resources = (await this.pve.get('/cluster/resources', { type: 'vm' })).filter((r) => r.type === 'qemu');
    const configs = await mapLimit(resources, 6, (r) => this.pve.get(`/nodes/${r.node}/qemu/${r.vmid}/config`).catch(() => ({})));
    const list = resources.map((r, i) => {
      const conf = configs[i] || {};
      const net0 = conf.net0 ? parseNet(conf.net0) : null;
      return {
        vmid: r.vmid,
        name: r.name || conf.name || `VM ${r.vmid}`,
        node: r.node,
        status: r.status,
        template: Boolean(r.template),
        vlan: net0?.tag ?? null,
        bridge: net0?.bridge ?? null,
        hasSerial: Object.keys(conf).some((k) => /^serial\d$/.test(k)),
      };
    }).sort((a, b) => a.vmid - b.vmid);
    this.#cache = { at: Date.now(), list };
    return list;
  }

  async listNodes() {
    const nodes = await this.pve.get('/nodes');
    return nodes.filter((n) => n.status === 'online').map((n) => n.node).sort();
  }

  async power(node, vmid, action) {
    const endpoint = POWER[action];
    if (!endpoint) throw new ProxmoxError(400, 'Unknown power action');
    const vm = await this.#findVm(node, vmid);
    const upid = await this.pve.post(`/nodes/${vm.node}/qemu/${vm.vmid}/status/${endpoint}`, {});
    const verb = { start: 'Starting', stop: 'Stopping', 'force-stop': 'Force-stopping' }[action];
    this.#track(`${verb} ${vm.name}`, async (step) => {
      step('Waiting for Proxmox');
      await this.#waitTask(upid);
      return `${vm.name} is ${action === 'start' ? 'running' : 'stopped'}`;
    });
    return { ok: true };
  }

  /** Sets the VLAN tag of net0, or removes it with tag = null */
  async setVlan(node, vmid, tag) {
    if (tag !== null && !isVlan(tag)) throw new ProxmoxError(400, 'VLAN tag must be a number from 1 to 4094');
    const vm = await this.#findVm(node, vmid);
    const conf = await this.pve.get(`/nodes/${vm.node}/qemu/${vm.vmid}/config`);
    if (!conf.net0) throw new ProxmoxError(409, `${vm.name} has no net0`);
    await this.pve.put(`/nodes/${vm.node}/qemu/${vm.vmid}/config`, { net0: setNetTag(conf.net0, tag), digest: conf.digest });
    this.log.info(`${vm.name} (${vm.vmid}) net0 VLAN → ${tag ?? 'untagged'}`);
    this.#changed();
    return { vmid: vm.vmid, vlan: tag };
  }

  /** Clone a template into a new VM and put its net0 on the given VLAN (background job) */
  async cloneTemplate({ template, name, node, vlan }) {
    if (!NAME_RE.test(name || '')) throw new ProxmoxError(400, 'Name: letters, digits and dashes only (it becomes the VM hostname)');
    if (vlan !== null && !isVlan(vlan)) throw new ProxmoxError(400, 'VLAN tag must be a number from 1 to 4094');
    if (node && !NODE_RE.test(node)) throw new ProxmoxError(400, 'Invalid node');
    const tpl = (await this.listVms({ fresh: true })).find((v) => v.vmid === Number(template) && v.template);
    if (!tpl) throw new ProxmoxError(404, 'Template not found');
    const target = node || tpl.node;

    return this.#track(`Clone ${name}`, async (step) => {
      const newid = Number(await this.pve.get('/cluster/nextid'));
      step(`Cloning ${tpl.name} into VM ${newid}`);
      await this.#waitTask(await this.pve.post(`/nodes/${tpl.node}/qemu/${tpl.vmid}/clone`, {
        newid, name, full: 1, target: target !== tpl.node ? target : undefined,
      }));
      if (vlan !== null) {
        step(`Putting net0 on VLAN ${vlan}`);
        const conf = await this.pve.get(`/nodes/${target}/qemu/${newid}/config`);
        if (!conf.net0) throw new ProxmoxError(400, 'The template has no net0 to tag');
        await this.pve.put(`/nodes/${target}/qemu/${newid}/config`, { net0: setNetTag(conf.net0, vlan), digest: conf.digest });
      }
      return `${name} (VM ${newid}) is ready on ${target}`;
    });
  }

  /** Console tickets; only the WebSocket bridges see them */
  async openTermProxy(node, vmid) {
    const vm = await this.#findRunning(node, vmid);
    const conf = await this.pve.get(`/nodes/${vm.node}/qemu/${vm.vmid}/config`);
    const serial = Object.keys(conf).find((k) => /^serial\d$/.test(k));
    if (!serial) throw new ProxmoxError(409, `${vm.name} has no serial port. Use VNC instead.`);
    return { vm, ...(await this.pve.post(`/nodes/${vm.node}/qemu/${vm.vmid}/termproxy`, { serial })) };
  }

  async openVncProxy(node, vmid) {
    const vm = await this.#findRunning(node, vmid);
    return { vm, ...(await this.pve.post(`/nodes/${vm.node}/qemu/${vm.vmid}/vncproxy`, { websocket: 1 })) };
  }

  jobs() {
    return [...this.#jobs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 8);
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  async #findVm(node, vmid) {
    const id = Number(vmid);
    if (!NODE_RE.test(String(node)) || !Number.isInteger(id) || id < 100) throw new ProxmoxError(400, 'Invalid VM reference');
    const vm = (await this.listVms({ fresh: true })).find((v) => v.vmid === id && v.node === node);
    if (!vm) throw new ProxmoxError(404, 'VM not found');
    if (vm.template) throw new ProxmoxError(409, `${vm.name} is a template`);
    return vm;
  }

  async #findRunning(node, vmid) {
    const vm = await this.#findVm(node, vmid);
    if (vm.status !== 'running') throw new ProxmoxError(409, `${vm.name} is not running. Start it first.`);
    return vm;
  }

  async #waitTask(upid, timeoutMs = 30 * 60_000) {
    const node = String(upid).split(':')[1];
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const st = await this.pve.get(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
      if (st.status === 'stopped') {
        if (st.exitstatus !== 'OK') throw new ProxmoxError(500, `Proxmox task failed: ${st.exitstatus}`);
        return;
      }
      await sleep(this.taskPollMs);
    }
    throw new ProxmoxError(504, 'Proxmox task is still running after 30 minutes');
  }

  #track(label, fn) {
    const job = { id: crypto.randomUUID(), label, state: 'running', message: 'Starting', startedAt: Date.now() };
    this.#jobs.set(job.id, job);
    const publish = () => this.events.publish('proxmox:jobs', this.jobs(), { sticky: true });
    const step = (message) => { job.message = message; publish(); };
    publish();
    fn(step).then(
      (message) => Object.assign(job, { state: 'done', message }),
      (err) => { Object.assign(job, { state: 'error', message: err.message }); this.log.warn(`${label} failed: ${err.message}`); },
    ).finally(() => {
      publish();
      this.#changed();
      setTimeout(() => { this.#jobs.delete(job.id); publish(); }, 10 * 60_000).unref();
    });
    return { jobId: job.id };
  }

  #changed() {
    this.#cache.at = 0;
    this.events.publish('proxmox:changed', { at: Date.now() });
  }
}

const isVlan = (n) => Number.isInteger(n) && n >= 1 && n <= 4094;

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
