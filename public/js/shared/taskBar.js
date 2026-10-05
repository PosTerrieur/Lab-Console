/**
 * Status strip shown under a console tile's header while an export or a
 * script runs: what is happening, a progress bar, a Stop button; then the
 * outcome, including each device error with its script line number
 */
import { h, icon } from '../core/dom.js';

const ICON = { done: 'check', warning: 'warning', error: 'warning', cancelled: 'close' };

export class TaskBar {
  #hideTimer = null;

  constructor({ onStop }) {
    this.text = h('span.task-text');
    this.bar = h('span.task-progress', h('span.task-fill'));
    this.details = h('ul.task-errors', { hidden: true });
    this.stopBtn = h('button.btn.small', { type: 'button', onclick: onStop }, icon('stop'), 'Stop');
    this.toggleBtn = h('button.btn.small.subtle', { type: 'button', hidden: true, onclick: () => this.#toggleDetails() }, 'Show errors');
    this.closeBtn = h('button.icon-btn', { type: 'button', title: 'Dismiss', hidden: true, onclick: () => this.hide() }, icon('close'));
    this.lead = h('span.task-lead');
    this.el = h('div.pane-task', { hidden: true, role: 'status', 'aria-live': 'polite' },
      h('div.task-row', this.lead, this.text, this.bar, this.toggleBtn, this.stopBtn, this.closeBtn),
      this.details);
  }

  get running() { return this.el.dataset.state === 'running'; }

  /** Handles a server {type:'automation'} message */
  update(msg) {
    clearTimeout(this.#hideTimer);
    this.el.hidden = false;
    this.el.dataset.state = msg.state;
    const running = msg.state === 'running';
    // Keystrokes are held back server-side while a task runs: say so
    this.text.replaceChildren(msg.message, running ? h('span.task-note', 'Keyboard paused until it finishes') : '');
    this.lead.replaceChildren(running ? h('span.spinner', { 'aria-hidden': 'true' }) : icon(ICON[msg.state] || 'check'));
    this.stopBtn.hidden = !running;
    this.closeBtn.hidden = running;
    const total = msg.total ?? msg.result?.total;
    const done = msg.done ?? msg.result?.sent;
    this.bar.hidden = !total;
    if (total) this.bar.firstChild.style.width = `${Math.round((100 * (done || 0)) / total)}%`;

    const errors = msg.result?.errors || [];
    this.toggleBtn.hidden = !errors.length;
    this.details.replaceChildren(...errors.map((e) => h('li', h('code', `line ${e.line}`), h('span', e.command), h('em', e.message))));
    if (!errors.length) this.details.hidden = true;
    if (msg.state === 'done') this.#hideTimer = setTimeout(() => this.hide(), 8000);
  }

  hide() {
    this.el.hidden = true;
    this.el.dataset.state = '';
    this.details.hidden = true;
    this.toggleBtn.textContent = 'Show errors';
  }

  #toggleDetails() {
    this.details.hidden = !this.details.hidden;
    this.toggleBtn.textContent = this.details.hidden ? 'Show errors' : 'Hide errors';
  }
}

/** Saves text as a file through the browser's download mechanism */
export function downloadText(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
