import { test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { WakeNudge, looksLikePrompt } from '../src/modules/consoles/consoleSession.js';

const BANNER = "Trying 10.22.9.211...\r\nConnected to 10.22.9.211.\r\nEscape character is '^]'.\r\n";
let sent;
const nudge = (opts = {}) => new WakeNudge({ idleMs: 2500, write: (s) => sent.push(s), ...opts });

beforeEach(() => { sent = []; mock.timers.enable({ apis: ['setTimeout', 'Date'] }); });
afterEach(() => mock.timers.reset());

test('bug report: "login:" right after the banner → no Enter is ever sent', () => {
  const n = nudge();
  n.feed(BANNER + '\r\nlogin: ');
  mock.timers.tick(10_000);
  assert.deepEqual(sent, []);
});

test('"login:" arriving in a later chunk cancels the pending nudge', () => {
  const n = nudge();
  n.feed(BANNER);
  mock.timers.tick(1000);
  n.feed('\r\nUsername: ');
  mock.timers.tick(10_000);
  assert.deepEqual(sent, []);
});

test('silent console line → exactly one Enter after 2.5 s of idle', () => {
  const n = nudge();
  n.feed(BANNER);
  mock.timers.tick(2499);
  assert.deepEqual(sent, []);
  mock.timers.tick(1);
  assert.deepEqual(sent, ['\r']);
  n.feed(BANNER);
  mock.timers.tick(10_000);
  assert.deepEqual(sent, ['\r']);
});

test('output restarts the idle timer; "Press RETURN" banners still get woken', () => {
  const n = nudge();
  n.feed(BANNER);
  mock.timers.tick(2000);
  n.feed('\r\nR1 con0 is now available\r\n\r\nPress RETURN to get started.\r\n');
  mock.timers.tick(2000);
  assert.deepEqual(sent, []);
  mock.timers.tick(500);
  assert.deepEqual(sent, ['\r']);
});

test('never armed while telnet is still dialing', () => {
  const n = nudge();
  n.feed('Trying 10.22.9.211...\r\n');
  mock.timers.tick(10_000);
  assert.deepEqual(sent, []);
});

test('the student typing first cancels it', () => {
  const n = nudge();
  n.feed(BANNER);
  n.cancel();
  mock.timers.tick(10_000);
  assert.deepEqual(sent, []);
});

test('0 disables the nudge', () => {
  const n = nudge({ idleMs: 0 });
  n.feed(BANNER);
  mock.timers.tick(10_000);
  assert.deepEqual(sent, []);
});

test('prompt detection', () => {
  for (const p of ['login:', 'Username:', 'Password:', 'Enter password:', 'R1>', 'S1#', 'R1(config-if)#', 'rommon 1 >', 'switch:', 'user@ts:~$'])
    assert.ok(looksLikePrompt(p), p);
  for (const p of ["Escape character is '^]'.", 'Connected to 10.22.9.211.', 'Press RETURN to get started!', ''])
    assert.ok(!looksLikePrompt(p), p);
});
