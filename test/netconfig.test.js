import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseNet, setNetTag } from '../src/modules/proxmox/netconfig.js';

const NIC = 'virtio=BC:24:11:5A:00:01,bridge=vmbr0,firewall=1,tag=2001,queues=4';

test('parses model, MAC, bridge and tag', () => {
  assert.deepEqual(parseNet(NIC), { model: 'virtio', mac: 'BC:24:11:5A:00:01', bridge: 'vmbr0', tag: 2001, firewall: true, linkDown: false, trunks: null });
});

test('changing the tag keeps MAC and every other option in place', () => {
  assert.equal(setNetTag(NIC, 2010), 'virtio=BC:24:11:5A:00:01,bridge=vmbr0,tag=2010,firewall=1,queues=4');
});

test('tag can be added to an untagged NIC and removed again', () => {
  const untagged = 'e1000=BC:24:11:00:00:09,bridge=vmbr0,firewall=0';
  assert.equal(setNetTag(untagged, 2005), 'e1000=BC:24:11:00:00:09,bridge=vmbr0,tag=2005,firewall=0');
  assert.equal(setNetTag(setNetTag(untagged, 2005), null), untagged);
});

test('legacy model=/macaddr= form is understood', () => {
  assert.equal(parseNet('model=virtio,macaddr=BC:24:11:00:00:01,bridge=vmbr1').mac, 'BC:24:11:00:00:01');
});
