'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { parseProtocolLine, redactSecrets } = require('../../apps/desktop/shared/protocol');
const { RETRY_STATE_CLEANUP_POLICY } = require('../../backend/mediaforge/modules/srt_to_speech/desktop-adapter');

test('legacy protocol prefixes stay private to boundary adapters', () => {
  assert.deepEqual(parseProtocolLine('BILI_EVENT {"type":"progress"}', 'BILI_EVENT '), { kind: 'event', payload: { type: 'progress' } });
  assert.deepEqual(parseProtocolLine('diagnostic', 'BILI_EVENT '), { kind: 'log', message: 'diagnostic' });
});

test('SRT retry state is retained on application quit', () => {
  assert.equal(RETRY_STATE_CLEANUP_POLICY, 'explicit-only');
  const main = fs.readFileSync(path.resolve(__dirname, '../../SRT-to-Speech-Studio/electron-app/main.js'), 'utf8');
  const beforeQuit = main.slice(main.indexOf("app.on('before-quit'"));
  assert.doesNotMatch(beforeQuit, /sessionStateDirectories|rm\(stateDirectory/);
});

test('log normalization masks Bili cookies, authorization, and tokens', () => {
  const output = redactSecrets('Cookie: SESSDATA=secret; bili_jct=csrf access_token=token Authorization: Bearer authvalue');
  for (const secret of ['secret', 'csrf', 'token', 'authvalue']) assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /\*\*\*/);
});
