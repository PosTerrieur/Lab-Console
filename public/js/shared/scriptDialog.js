/**
 * "Inject script" dialog: paste or type commands, or load a text file
 * (button or drag-and-drop), choose the pacing, send; The pacing itself
 * happens on the server (see src/lib/cliAutomation.js), so it stays exact
 * even if this tab goes to the background
 */
import { h, icon, prefs } from '../core/dom.js';

const MAX_BYTES = 256 * 1024;
const lastScripts = new Map(); // per console, for this page session

export function openScriptDialog({ session, onSend }) {
  const saved = prefs.get('injectOptions', {});
  const textarea = h('textarea.field.script-input', {
    spellcheck: 'false', autocomplete: 'off', wrap: 'off', rows: 16, 'aria-label': 'Commands to send',
    placeholder: 'configure terminal\ninterface g0/0/0\n ip address 192.168.1.1 255.255.255.0\n no shutdown\nend',
  });
  textarea.value = lastScripts.get(session.key) || '';
  const fileInput = h('input', { type: 'file', accept: '.txt,.cfg,.conf,.ios,.log,text/plain', hidden: true });
  const fileName = h('span.script-file');
  const count = h('span.script-count');
  const error = h('p.form-error', { role: 'alert' });

  const waitPrompt = h('input', { type: 'checkbox', checked: saved.waitForPrompt !== false });
  const delay = h('input.field.delay-input', { type: 'number', min: 0, max: 5000, step: 10, value: saved.delayMs ?? 50, 'aria-label': 'Delay between lines in milliseconds' });
  const skipComments = h('input', { type: 'checkbox', checked: saved.skipComments !== false });
  const stopOnError = h('input', { type: 'checkbox', checked: Boolean(saved.stopOnError) });
  const send = h('button.btn.primary', { type: 'submit' }, icon('script'), 'Send commands');

  // Same rule as the server (parseScript): blank lines count, the final newline doesn't
  const lineCount = () => {
    const text = textarea.value.replace(/\r\n?/g, '\n');
    if (!text.trim()) return 0;
    const lines = text.split('\n');
    if (text.endsWith('\n')) lines.pop();
    return lines.filter((l) => !(skipComments.checked && /^\s*!/.test(l))).length;
  };
  const refresh = () => {
    const n = lineCount();
    count.textContent = n === 1 ? '1 line to send' : `${n} lines to send`;
    send.disabled = n === 0;
  };

  const load = async (file) => {
    error.textContent = '';
    if (!file) return;
    if (file.size > MAX_BYTES) { error.textContent = `${file.name} is larger than 256 KB.`; return; }
    textarea.value = await file.text();
    fileName.textContent = file.name;
    refresh();
  };
  fileInput.addEventListener('change', () => load(fileInput.files[0]));
  textarea.addEventListener('input', () => { fileName.textContent = ''; refresh(); });
  skipComments.addEventListener('change', refresh);
  textarea.addEventListener('dragover', (e) => { e.preventDefault(); textarea.classList.add('drop'); });
  textarea.addEventListener('dragleave', () => textarea.classList.remove('drop'));
  textarea.addEventListener('drop', (e) => { e.preventDefault(); textarea.classList.remove('drop'); load(e.dataTransfer.files[0]); });
  textarea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) form.requestSubmit(); });

  const form = h('form.modal-body.script-form', {
    onsubmit: (e) => {
      e.preventDefault();
      if (new Blob([textarea.value]).size > MAX_BYTES) { error.textContent = 'The script is larger than 256 KB.'; return; }
      const options = {
        waitForPrompt: waitPrompt.checked,
        delayMs: Number(delay.value) || 0,
        skipComments: skipComments.checked,
        stopOnError: stopOnError.checked,
      };
      prefs.set('injectOptions', options);
      lastScripts.set(session.key, textarea.value);
      onSend(textarea.value, options);
      dlg.close();
    },
  },
  h('div.script-bar',
    h('button.btn.small', { type: 'button', onclick: () => fileInput.click() }, icon('upload'), 'Upload file'),
    fileName, fileInput, count),
  textarea,
  h('p.muted.script-hint', 'One command per line, as you would type them. Blank lines are sent as Enter (to answer questions like "[confirm]"). You can also drop a .txt file here.'),
  h('fieldset.script-options',
    h('legend', 'Pacing'),
    h('label.check', waitPrompt, h('span', 'Wait for the prompt after each line', h('small', 'Recommended. The next line goes only once the device has answered.'))),
    h('label.inline', h('span', 'Delay between lines'), delay, h('span.muted', 'ms')),
    h('label.check', skipComments, h('span', 'Skip comment lines starting with "!"')),
    h('label.check', stopOnError, h('span', 'Stop at the first device error ("% Invalid input…")'))),
  error,
  h('div.form-actions', h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), send));

  const dlg = h('dialog.modal.wide', { 'aria-label': `Inject a script into ${session.title}` },
    h('header.modal-head', h('h2', `Inject a script into ${session.title}`),
      h('button.icon-btn', { type: 'button', title: 'Close', onclick: () => dlg.close() }, icon('close'))),
    form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  refresh();
  requestAnimationFrame(() => textarea.focus());
}
