/**
 * "Lab consoles" section: lab picker + topology diagram + the shared terminal workspace
 */
import { h, icon, toast, prefs } from '../../core/dom.js';
import { getJson, live } from '../../core/api.js';
import { workspace } from '../../shared/workspace.js';
import { SplitView } from '../../shared/splitView.js';
import { consoleSession } from '../../shared/sessions.js';
import { DiagramView } from './diagramView.js';
import { LabPicker } from './labPicker.js';
import { QuickOpen } from './quickOpen.js';

export function mount(el, { navigate }) {
  let labs = [];
  let current = null;
  let busy = new Set();
  let version = null;
  let pendingLabName = null;

  // ── Layout ────────────────────────────────────────────────────────────────
  const head = h('header.view-head', h('div.view-title', h('h1', 'Lab consoles'), h('p', 'Choose a bench, then click a device.')));
  const picker = new LabPicker(head, { onSelect: (lab) => selectLab(lab) });
  const quick = new QuickOpen({ onPick: (lab, device) => { selectLab(lab); openDevice(device); } });
  head.append(h('button.find-btn', { type: 'button', onclick: () => quick.open() }, icon('search'), h('span', 'Find a device'), h('kbd', 'Ctrl K')));

  const labTitle = h('h2.canvas-title');
  const labHint = h('p.canvas-hint');
  const notesBtn = h('button.notes-btn', { type: 'button', hidden: true, onclick: () => notes.toggleAttribute('hidden') }, icon('warning'));
  const notes = h('div.notes-pop', { hidden: true });
  const canvas = h('div.diagram-canvas');
  const diagramPane = h('div.diagram-pane', h('div.canvas-heading', labTitle, labHint), canvas, notesBtn, notes);
  el.append(head);
  const split = new SplitView(el, diagramPane, { label: 'Topology', onResize: () => diagram.fit() });
  const diagram = new DiagramView(canvas, { onOpen: (d) => openDevice(d) });
  workspace.addEventListener('change', () => refreshStates());

  // ── Data ──────────────────────────────────────────────────────────────────
  live.on('consoles:busy', (targets) => { busy = new Set(targets); refreshStates(); });
  // Live reload when an instructor edits the diagram (the first load doesn't
  // depend on the event stream, so a proxy that buffers SSE can't blank the page)
  live.on('labs:version', ({ version: v, error }) => {
    if (error) toast(error, 'error', 8000);
    if (version !== null && v !== version) loadLabs();
  });
  loadLabs();

  async function loadLabs() {
    try {
      const data = await getJson('/api/consoles/labs');
      version = data.version;
      labs = data.labs;
      picker.render(labs);
      quick.setLabs(labs);
      renderNotes(data.warnings);
      const keep = labs.find((l) => l.id === current?.id || l.name === pendingLabName) || labs.find((l) => l.name === prefs.get('lab')) || labs[0];
      if (keep) selectLab(keep, true);
      else labTitle.textContent = 'No labs found in the diagram file';
    } catch (err) {
      labTitle.textContent = 'The diagram could not be loaded';
      labHint.textContent = `${err.message}. Check that the platform is running, then reload the page.`;
    }
  }

  function selectLab(lab, force = false) {
    if (!force && current?.id === lab.id) return;
    current = lab;
    pendingLabName = null;
    prefs.set('lab', lab.name);
    navigate(`#/consoles/${encodeURIComponent(lab.name)}`);
    picker.setActive(lab.id);
    labTitle.textContent = lab.name;
    labHint.textContent = lab.devices.length
      ? `${lab.devices.length} devices. Click one to open its console.`
      : 'This page has no device with a console address.';
    diagram.render(lab);
    refreshStates();
  }

  // ── Consoles ──────────────────────────────────────────────────────────────
  const targetOf = (d) => `${d.target.host}:${d.target.port}`;

  function openDevice(device) {
    const session = consoleSession(device, current?.name ?? '');
    // Tiles are keyed by console line, so a device shown on several pages reuses its tile
    if (workspace.panes.has(session.key)) return workspace.open(session);
    if (!device.allowed) return toast(`${device.name}'s console address is not on the platform's allow-list.`, 'warn');
    if (busy.has(targetOf(device))) return toast(`${device.name}'s console is in use by another session. Try again when it is free.`, 'warn');
    workspace.open(session);
    diagram.pulse(device.key);
  }

  function refreshStates() {
    const mine = workspace.liveTargets();
    diagram.setStates((d) => {
      if (!d.allowed) return 'disabled';
      if (mine.has(targetOf(d))) return 'open';
      return busy.has(targetOf(d)) ? 'busy' : 'idle';
    });
    picker.setLive(new Set(labs.filter((l) => l.devices.some((d) => mine.has(targetOf(d)))).map((l) => l.id)));
  }

  function renderNotes(warnings = []) {
    notesBtn.hidden = !warnings.length;
    notesBtn.replaceChildren(icon('warning'), h('span', warnings.length === 1 ? '1 diagram note' : `${warnings.length} diagram notes`));
    notes.replaceChildren(h('p', 'Found while reading the diagram file:'), h('ul', warnings.map((w) => h('li', w))));
  }

  // Ctrl+K or "/" opens the device finder - but never steals keys from a terminal
  // (Ctrl+K is "erase to end of line" on Cisco IOS)
  document.addEventListener('keydown', (e) => {
    if (el.hidden || e.target.closest?.('.xterm, input, textarea')) return;
    if ((e.key === 'k' && (e.ctrlKey || e.metaKey)) || e.key === '/') {
      e.preventDefault();
      quick.open();
    }
  });

  return {
    show([labName] = []) {
      if (labName) {
        const lab = labs.find((l) => l.name === labName);
        if (lab) selectLab(lab);
        else pendingLabName = labName;
      }
      split.activate();
    },
  };
}
