/**
 * Session descriptors: what a workspace tile shows and where it connects
 * The browser only ever names things (device key, VM node + id); the server
 * resolves addresses and credentials
 */
export const consoleSession = (device, subtitle) => ({
  key: `console:${device.target.host}:${device.target.port}`, // one tile per physical console line
  kind: 'console',
  title: device.name,
  subtitle,
  address: `${device.target.host}:${device.target.port}`,
  target: device.target,
  ws: { path: '/ws/console', query: { device: device.key } },
});

export const vmSerialSession = (vm) => ({
  key: `vm-serial:${vm.node}:${vm.vmid}`,
  kind: 'serial',
  title: vm.name,
  subtitle: 'Serial',
  address: `VM ${vm.vmid} on ${vm.node}`,
  ws: { path: '/ws/proxmox/serial', query: { node: vm.node, vmid: vm.vmid } },
});

export const vmScreenSession = (vm) => ({
  key: `vm-screen:${vm.node}:${vm.vmid}`,
  kind: 'vnc',
  title: vm.name,
  subtitle: 'Screen',
  address: `VM ${vm.vmid} on ${vm.node}`,
  ws: { path: '/ws/proxmox/vnc', query: { node: vm.node, vmid: vm.vmid } },
});
