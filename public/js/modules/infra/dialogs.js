/**
 * "Clone template" dialog: template, name, node, VLAN tag of net0
 */
import { h, icon, toast } from '../../core/dom.js';
import { request } from '../../core/api.js';

export function openCloneDialog({ templates, nodes }) {
  const tpl = h('select.field', { required: true }, templates.map((t) => h('option', { value: t.vmid }, `${t.name} (${t.vmid}, ${t.node})`)));
  const name = h('input.field', { required: true, pattern: '[A-Za-z0-9]([A-Za-z0-9\\-]{0,61}[A-Za-z0-9])?', placeholder: 'e.g. vpc-5h1', autocomplete: 'off' });
  const node = h('select.field', h('option', { value: '' }, 'Same node as the template'), nodes.map((n) => h('option', { value: n }, n)));
  const vlan = h('input.field', { type: 'number', min: 1, max: 4094, placeholder: 'Untagged' });
  const error = h('p.form-error', { role: 'alert' });
  const submit = h('button.btn.primary', { type: 'submit' }, 'Clone');

  const form = h('form.modal-body.form-grid', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.textContent = '';
      submit.disabled = true;
      try {
        await request('POST', '/api/proxmox/clone', {
          template: Number(tpl.value), name: name.value.trim(), node: node.value || undefined,
          vlan: vlan.value === '' ? null : Number(vlan.value),
        });
        toast(`Cloning ${name.value.trim()}. Progress shows above the VM list.`);
        dlg.close();
      } catch (err) {
        error.textContent = err.message;
        submit.disabled = false;
      }
    },
  },
  h('label', h('span', 'Template'), tpl),
  h('label', h('span', 'Name'), name, h('small', 'Letters, digits and dashes. Becomes the VM hostname.')),
  h('label', h('span', 'Node'), node),
  h('label', h('span', 'VLAN tag of net0'), vlan, h('small', 'Leave empty for no tag.')),
  error,
  h('div.form-actions', h('button.btn', { type: 'button', onclick: () => dlg.close() }, 'Cancel'), submit));

  const dlg = h('dialog.modal', { 'aria-label': 'Clone template' },
    h('header.modal-head', h('h2', 'Clone template'),
      h('button.icon-btn', { type: 'button', title: 'Close', onclick: () => dlg.close() }, icon('close'))),
    form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  requestAnimationFrame(() => name.focus());
}
