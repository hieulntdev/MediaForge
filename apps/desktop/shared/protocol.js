'use strict';

const TASK_STATES = Object.freeze([
  'PENDING', 'RUNNING', 'PAUSED', 'CANCELLING', 'COMPLETED', 'FAILED', 'CANCELLED'
]);
const TERMINAL_STATES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

function parseProtocolLine(line, prefix = '') {
  const value = String(line || '').trim();
  if (!value) return null;
  if (prefix && !value.startsWith(prefix)) {
    return { kind: 'log', message: value.replace(/^\r+/, '') };
  }
  const encoded = prefix ? value.slice(prefix.length) : value;
  try {
    return { kind: 'event', payload: JSON.parse(encoded) };
  } catch {
    return { kind: 'log', message: value.replace(/^\r+/, '') };
  }
}

function redactSecrets(value) {
  return String(value ?? '')
    .replace(/(\b(?:SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|access_token|refresh_token|password|passwd|authorization)\b\s*[=:]\s*)[^\s&;,]+/gi, '$1***')
    .replace(/(Cookie\s*:\s*).*/gi, '$1***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1***');
}

module.exports = { TASK_STATES, TERMINAL_STATES, parseProtocolLine, redactSecrets };
