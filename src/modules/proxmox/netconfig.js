/**
 * Proxmox `netN` property strings, e.g.
 *   "virtio=BC:24:11:5A:00:01,bridge=vmbr0,firewall=1,tag=2001"
 *
 * Changing a VLAN tag must rewrite *only* `tag`: dropping the MAC would make
 * Proxmox generate a new one (new DHCP lease, guest sees a new NIC), and
 * dropping other options (firewall, rate, queues…) would silently reconfigure
 * the VM
 */
const MODELS = new Set(['e1000', 'e1000-82540em', 'e1000-82544gc', 'e1000-82545em', 'e1000e', 'i82551', 'i82557b',
  'i82559er', 'ne2k_isa', 'ne2k_pci', 'pcnet', 'rtl8139', 'virtio', 'vmxnet3']);

function split(str) {
  return String(str).split(',').filter(Boolean).map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p, undefined] : [p.slice(0, i), p.slice(i + 1)];
  });
}
const join = (parts) => parts.map(([k, v]) => (v === undefined ? k : `${k}=${v}`)).join(',');

export function parseNet(str) {
  const parts = split(str);
  const get = (k) => parts.find(([key]) => key === k)?.[1];
  const modelPart = parts.find(([k]) => MODELS.has(k));
  const tag = get('tag');
  return {
    model: modelPart?.[0] ?? get('model') ?? '',
    mac: modelPart?.[1] ?? get('macaddr') ?? '',
    bridge: get('bridge') ?? '',
    tag: tag === undefined ? null : Number(tag),
    firewall: get('firewall') === '1',
    linkDown: get('link_down') === '1',
    trunks: get('trunks') ?? null,
  };
}

/** Returns the same net string with only the VLAN tag set (or removed when tag is null) */
export function setNetTag(str, tag) {
  const parts = split(str).filter(([k]) => k !== 'tag');
  if (tag !== null && tag !== undefined) {
    const at = parts.findIndex(([k]) => k === 'bridge');
    parts.splice(at < 0 ? parts.length : at + 1, 0, ['tag', String(tag)]);
  }
  return join(parts);
}
