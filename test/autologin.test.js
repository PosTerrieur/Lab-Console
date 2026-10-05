import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AutoLogin } from '../src/modules/consoles/consoleSession.js';

const run = (creds, chunks) => {
  const sent = [];
  const a = new AutoLogin(creds, (s) => sent.push(s), () => {});
  for (const c of chunks) a.feed(c);
  clearTimeout(a.timer);
  return sent;
};

test('answers username then password once', () => {
  assert.deepEqual(run({ username: 'u', password: 'p' }, ['\r\nUser Access Verification\r\n\r\nUsername: ', 'u\r\nPassword: ', '\r\nR1>']), ['u\r', 'p\r']);
});

test('never answers a second login round (no lockout loops)', () => {
  assert.deepEqual(run({ username: 'u', password: 'bad' }, ['Username: ', 'Password: ', '% Login invalid\r\n\r\nUsername: ', 'Password: ']), ['u\r', 'bad\r']);
});

test('disengages when the line has no login, so "enable" passwords are never sent', () => {
  assert.deepEqual(run({ username: 'u', password: 'p' }, ['\r\nR1>', 'enable\r\nPassword: ']), []);
});

test('password-only lines work without a username', () => {
  assert.deepEqual(run({ username: '', password: 'p' }, ['\x1b[0mPassword: ']), ['p\r']);
});

test('stands down for good once cancelled (student typing their own login)', () => {
  const sent = [];
  const a = new AutoLogin({ username: 'u', password: 'p' }, (x) => sent.push(x), () => {});
  a.cancel();
  a.feed('Username: ');
  a.feed('Password: ');
  assert.deepEqual(sent, []);
});
