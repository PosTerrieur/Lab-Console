/**
 * The admin switches: console devices outside the lab diagrams, reached
 * through the same jump server → telnet chain; Listed in
 * config/infrastructure.json so instructors can edit them without code
 */
import fs from 'node:fs';

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

export function loadInfrastructure(file, logger) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    logger.warn(`No infrastructure file at ${file} (${err.code || err.message}); no admin switches listed`);
    return { adminSwitches: [] };
  }
  const problems = [];
  const adminSwitches = (raw.adminSwitches || []).filter((s, i) => {
    const ok = ID.test(s.id || '') && s.name && s.host && Number.isInteger(s.port);
    if (!ok) problems.push(`adminSwitches[${i}] needs id (a-z0-9-), name, host and integer port`);
    return ok;
  }).map((s) => ({
    id: s.id,
    key: `admin:${s.id}`,      // the device key the browser sends; host/port stay server-side
    name: s.name,
    bay: s.bay || '',
    labName: [s.bay, s.name].filter(Boolean).join(' '),
    target: { host: String(s.host), port: s.port },
  }));
  for (const p of problems) logger.warn(`infrastructure.json: ${p}`);
  return { adminSwitches };
}
