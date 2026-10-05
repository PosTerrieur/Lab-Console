/**
 * Server-Sent Events hub: one-way live updates to every open browser tab
 * (console busy/free indicators, diagram reloads, future Proxmox VM state…)
 */
export class EventHub {
  #clients = new Set();
  #snapshots = new Map(); // topic → last payload, replayed to new subscribers

  handler = (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // nginx: don't buffer the stream
    });
    res.write('retry: 3000\n\n');
    for (const [topic, data] of this.#snapshots) send(res, topic, data);
    this.#clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(ping); this.#clients.delete(res); });
  };

  /** Broadcast; `sticky` topics are remembered and replayed on connect */
  publish(topic, data, { sticky = false } = {}) {
    if (sticky) this.#snapshots.set(topic, data);
    for (const res of this.#clients) send(res, topic, data);
  }
}

function send(res, topic, data) {
  res.write(`event: ${topic}\ndata: ${JSON.stringify(data)}\n\n`);
}
