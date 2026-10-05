/**
 * WebSocket glue between a console tile and its CliAutomation (shared by lab /
 * admin-switch consoles and Proxmox serial consoles)
 *
 *   browser → server   {"type":"export-config"}
 *                      {"type":"inject","script":"…","options":{waitForPrompt,delayMs,stopOnError,skipComments}}
 *                      {"type":"automation-cancel"}
 *   server → browser   {"type":"automation","task","state":"running|done|error|cancelled","message","done","total","result"}
 *                      {"type":"export-result","filename","content"}
 */
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_SCRIPT_LINES = 5000;

export function createAutomationHandler({ cli, send, canExport, log, label }) {
  return function handle(msg) {
    if (msg.type === 'automation-cancel') { cli.cancel(); return true; }
    if (msg.type !== 'export-config' && msg.type !== 'inject') return false;

    const task = msg.type === 'export-config' ? 'export' : 'inject';
    const report = (state, message, extra = {}) => send({ type: 'automation', task, state, message, ...extra });
    if (cli.running) return report('error', 'Another task is still running on this console.'), true;
    if (task === 'export' && !canExport) return report('error', 'Config export is available on Cisco console devices only.'), true;

    let run;
    if (task === 'export') {
      run = cli.exportRunningConfig((message) => report('running', message)).then(({ hostname, config, pagingFallback }) => {
        send({ type: 'export-result', filename: exportFilename(hostname), content: config });
        const lines = config.split('\n').length - 1;
        report('done', `Exported ${lines} lines of ${hostname}'s running-config${pagingFallback ? ' (paging could not be disabled; --More-- pages were skipped through)' : ''}`);
        log.info(`${label}: exported running-config of ${hostname} (${lines} lines)`);
      });
    } else {
      const script = typeof msg.script === 'string' ? msg.script : '';
      if (!script.trim()) return report('error', 'The script is empty.'), true;
      if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) return report('error', 'The script is larger than 256 KB.'), true;
      if (script.split('\n').length > MAX_SCRIPT_LINES) return report('error', `The script has more than ${MAX_SCRIPT_LINES} lines.`), true;
      const o = msg.options || {};
      const options = {
        waitForPrompt: o.waitForPrompt !== false,
        delayMs: clamp(o.delayMs, 0, 5000, 50),
        stopOnError: Boolean(o.stopOnError),
        skipComments: o.skipComments !== false,
      };
      run = cli.injectScript(script, options, (message, p = {}) => report('running', message, p)).then((result) => {
        const { sent, total, errors, slow } = result;
        const parts = [`Sent ${sent} of ${total} lines`];
        if (errors.length) parts.push(`${errors.length} device error${errors.length > 1 ? 's' : ''} (line ${errors.map((e) => e.line).join(', ')})`);
        if (slow.length) parts.push(`no prompt after line ${slow.join(', ')}`);
        if (result.stoppedOnError) parts.push('stopped at the first error');
        if (result.waitingFor) parts.push(`the device is waiting for an answer: "${result.waitingFor}"`);
        report(errors.length || result.waitingFor ? 'warning' : 'done', parts.join('. '), { result });
        log.info(`${label}: injected ${sent}/${total} lines, ${errors.length} errors`);
      });
    }
    run.catch((err) => report(err.cancelled ? 'cancelled' : 'error', err.cancelled ? 'Stopped' : err.message));
    return true;
  };
}

function exportFilename(hostname) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
  return `${hostname.replace(/[^\w.-]/g, '_')}_running-config_${stamp}.txt`;
}

const clamp = (v, min, max, fallback) => (Number.isFinite(Number(v)) ? Math.min(max, Math.max(min, Number(v))) : fallback);
