/**
 * Lab Console - HTTP + WebSocket entry point
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { createLogger } from './lib/logger.js';
import { EventHub } from './lib/events.js';
import { securityHeaders, isOriginAllowed } from './lib/security.js';
import { loadInfrastructure } from './lib/infrastructure.js';
import { createModules } from './modules/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const log = createLogger('server');
const events = new EventHub();
const infra = loadInfrastructure(config.infraConfigPath, createLogger('infra'));
const modules = createModules({ config, events, logger: createLogger('app'), infra });

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.server.trustProxy);
app.use(securityHeaders);

// ── Self-hosted front-end dependencies (works on isolated lab networks) ─────
const vendor = (pkgPath) => express.static(path.join(root, 'node_modules', pkgPath), { maxAge: '7d', immutable: true });
app.use('/vendor/xterm', vendor('@xterm/xterm'));
app.use('/vendor/xterm-addon-fit', vendor('@xterm/addon-fit'));
app.use('/vendor/novnc', vendor('@novnc/novnc'));
app.use('/vendor/fonts/plex-sans', vendor('@fontsource/ibm-plex-sans'));
app.use('/vendor/fonts/plex-mono', vendor('@fontsource/ibm-plex-mono'));
app.use(express.static(path.join(root, 'public'), { index: 'index.html' }));

// ── API ─────────────────────────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true }));
// State-changing API calls must come from the platform's own pages, so another
// website can't make a visitor's browser power off VMs (cross-site request forgery)
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || isOriginAllowed(req, config.server.allowedOrigins)) return next();
  res.status(403).json({ error: 'Cross-origin request refused' });
});
app.get('/api/events', events.handler);
app.get('/api/modules', (_req, res) =>
  res.json(modules.map(({ id, title, enabled }) => ({ id, title, enabled }))));
for (const m of modules) if (m.router) app.use(`/api/${m.id}`, m.router);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, _req, res, _next) => {
  log.error(err.stack || String(err));
  res.status(500).json({ error: 'Internal error' });
});

// ── WebSocket upgrades are dispatched to the module that owns the path ───────
const server = http.createServer(app);
server.on('upgrade', (req, socket, head) => {
  for (const m of modules) if (m.upgrade?.(req, socket, head)) return;
  socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
});

server.listen(config.server.port, config.server.host, () => {
  log.info(`Lab Console listening on http://${config.server.host}:${config.server.port}`);
  log.info(`Jump server ${config.ssh.username}@${config.ssh.host}:${config.ssh.port}`);
});

function shutdown(signal) {
  log.info(`${signal} received, closing consoles…`);
  for (const m of modules) m.shutdown?.();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
