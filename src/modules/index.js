/**
 * Module registry. Each feature area of the platform is a self-contained
 * module mounted under /api/<id> (HTTP) and optionally /ws/<id> (WebSocket).
 * Adding a feature = adding one line here + one folder.
 */
import { createConsolesModule } from './consoles/index.js';
import { createProxmoxModule } from './proxmox/index.js';

export function createModules(deps) {
  return [createConsolesModule(deps), createProxmoxModule(deps)];
}
