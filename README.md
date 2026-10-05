# Lab Console

Browser access to the physical lab equipment. Pick a bench, click a router or
switch on its diagram, and its console opens in a terminal next to the
diagram. Open several at once to configure devices side by side.

```
Browser ──WebSocket──► Lab Console ──SSH (exec)──► jump server ──telnet──► console server ──► device
```

## Quick start (Docker)

```bash
cp .env.example .env        # Windows: Copy-Item .env.example .env
# edit .env: SSH_* (jump server) and TELNET_* (console login)
docker compose up -d --build
```

Open http://localhost:3000.

Without Docker (Node.js 20.12 or newer):

```bash
npm ci
npm start
```

## Try it without the lab

`dev/mock-lab.js` runs a fake SSH jump server whose "devices" answer like a
small Cisco IOS console (login, `enable`, `conf t`, `show ip int brief`…).

```bash
# in .env
SSH_HOST=127.0.0.1
SSH_PORT=2222
npm run mock-lab     # terminal 1
npm start            # terminal 2
```

`MOCK_DOWN_PORTS=2003` simulates an unplugged console.
`MOCK_LOGIN_PORTS=2001` simulates a terminal server that shows `login:`
immediately and hangs up on an empty login.

## The diagram

`diagrams/diagram.drawio` is the single source of truth. Each page is a lab.
The app watches the file and reloads it a few seconds after it changes, so
there is no restart.

A shape becomes a clickable device when either:

1. its label contains the console reference, as in the current diagrams:
   `R1` on the first line, `.211 - 2001` on the second
   (→ `CONSOLE_NETWORK_PREFIX.211`, port 2001; a full IP such as
   `10.22.9.211 - 2001` also works), or
2. it carries data (draw.io › right click › *Edit Data*): `console_host` and
   `console_port`. This wins over the label.

Check a diagram before deploying it:

```bash
npm run check-diagram                     # or: npm run check-diagram -- other.drawio
```

It lists every device per lab and flags console lines used by two different
devices (exit code 1). The current file has one: on **B5H, R4 and S1 both
point to `.212 - 2005`**. Devices that appear on several pages with the same
name and console (S5, R5) are treated as shared equipment.

Page names such as `B4H / B4M / B4B` are shown as rack elevations (bay 4,
top/middle/bottom). Any other naming falls back to plain tabs.

## Security model

- **The browser never chooses where to connect.** It sends a device key from
  the diagram; the server looks up host and port in its own copy of the file
  and checks them against `ALLOWED_CONSOLE_HOSTS` and `ALLOWED_PORT_RANGE`.
- **No shell on the jump server.** Each terminal is an SSH `exec` of
  `telnet <host> <port>`; when telnet ends, the SSH channel ends.
- **No `telnet>` escape.** `Ctrl+]` is stripped from student input, so
  telnet's command mode (which can spawn a shell with `!`) is unreachable. The
  *Send BREAK* button is the only server-side use of it.
- **Credentials stay on the server.** Auto-login answers only the first
  Username/Password prompt of a line, once, within 30 s, and stops as soon as
  a device prompt appears. `enable` passwords are never sent.
- **One student per console line**, idle sessions closed after
  `IDLE_TIMEOUT_MINUTES`, per-client and global session limits, and a rate
  limit on opening consoles.
- WebSockets accept only the platform's own origin (`ALLOWED_ORIGINS` adds
  more). The UI is fully self-hosted under a strict Content-Security-Policy.
- Set `SSH_HOST_FINGERPRINT` to pin the jump server's identity. Until you do,
  the server logs the fingerprint it sees.

Recommended on the jump server: a dedicated account that may only run telnet,
for example `ForceCommand` in `sshd_config` or a restricted shell.

The platform has no login: anyone who can open it can use the lab consoles,
the admin switches and the Proxmox VMs. Expose it on the lab network only, or
behind your school's reverse proxy/SSO (set `TRUST_PROXY=true`).

## Infrastructure section

The **Infra** entry in the sidebar is open to everyone, like the lab consoles.

- **Virtual machines**: every Proxmox VM, with:
  - **Start / Stop / Force stop** (Stop asks the guest to shut down; Force stop cuts the power);
  - **Serial** (text console in xterm.js, for VMs with a serial port) and **VNC** (graphical console);
  - the **VLAN tag of net0**: type a number and press Enter, or leave empty for untagged.
    The MAC address and the other NIC options are kept;
  - **Clone template**: template, name, node, VLAN. A full clone, with progress shown live.
- **Admin switches**: the four switches from `config/infrastructure.json`. Their
  consoles go through the same jump server → telnet chain as the lab devices.

All consoles share one workspace, so an admin switch and a VM screen can be
side by side, and they stay open when you switch sections.

### How Proxmox is reached: through the jump server

```
platform ──SSH──► jump server ──direct-tcpip──► 10.22.9.20:8006 (Proxmox)
           one shared connection, one lightweight channel per HTTPS socket / console
```

- The platform keeps **one** SSH connection to the jump server for Proxmox
  (`src/lib/sshTunnel.js`). Every HTTPS request and every console WebSocket is an
  SSH `forwardOut` channel on it, with TLS end-to-end to Proxmox inside.
- HTTPS sockets are kept alive, and at most 6 API requests run at once, so
  listing 20 VMs reuses a handful of channels.
- If the jump server drops the connection, it is re-opened on the next call.
- The jump account must be allowed to forward TCP. That is OpenSSH's default
  (`AllowTcpForwarding yes`). To restrict it to Proxmox only:
  ```
  Match User labjump
      PermitOpen 10.22.9.20:8006
  ```
- Authentication is a username/password **ticket**, renewed before Proxmox's
  2-hour expiry and again on any 401. No Proxmox credential, ticket or VNC
  password reaches the browser:
  - for **VNC**, the platform does the VNC password exchange with Proxmox itself;
  - for **Serial**, it translates Proxmox's `termproxy` protocol to the platform's own.

### Serial consoles

A VM needs a serial port for **Serial**: `qm set <vmid> -serial0 socket`, and
in a Linux guest `systemctl enable --now serial-getty@ttyS0`. Add the port to
your templates so every clone has it. **VNC** works on every VM.

### Try it without Proxmox

```bash
npm run mock-lab       # fake jump server; also forwards 10.22.9.20:8006 to the mock Proxmox
npm run mock-proxmox   # fake Proxmox on 127.0.0.1:8006; prints PROXMOX_FINGERPRINT=…
```

In `.env`, set `PROXMOX_URL=https://10.22.9.20:8006` (yes, the lab address)
and the printed fingerprint. The mock jump server is the only way to that
address, exactly like in the lab.

## Project layout

```
src/
  server.js                 HTTP + WebSocket entry, mounts modules
  config.js                 .env loading and validation
  lib/                      logger, SSE hub, security helpers, SSH options + shared SSH tunnel
  modules/
    index.js                module registry
    consoles/               lab consoles: diagram parser, registry, SSH→telnet sessions
    proxmox/                Proxmox client (ticket auth, over the SSH tunnel), service, console proxies
public/
  index.html, css/app.css
  js/main.js                shell: sidebar, routing, theme
  js/core/                  DOM helpers, API + live events
  js/modules/consoles/      diagram renderer, terminal workspace, lab picker, finder
  js/shared/                workspace (shared by all sections), terminal + VNC panes, split layout
  js/modules/infra/         Infrastructure section: VMs, network dialog, admin switches
scripts/check-diagram.js    diagram linter
dev/mock-lab.js             fake jump server (telnet + port forwarding) + IOS consoles
dev/mock-proxmox.js         fake Proxmox VE (HTTPS, API, serial + VNC consoles)
config/infrastructure.json  admin switches
test/                       node:test unit tests (npm test)
```

## Keyboard

| Keys | Action |
|---|---|
| `Ctrl K` or `/` (outside a terminal) | Find a device in any lab |
| `Tab`, then `Enter` on the diagram | Open the focused device |
| `Ctrl Shift C` in a terminal | Copy the selection |
| `Ctrl V` in a terminal | Paste |
