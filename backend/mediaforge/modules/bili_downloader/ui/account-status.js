(function exposeAccountStatus(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BiliAccountStatus = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  'use strict';

  const messages = Object.freeze({
    valid: 'Cookie is valid. Authentication successful.',
    expired: 'Cookie has expired. Please refresh your cookies.',
    invalid: 'Cookie authentication failed. Please check your cookie file.',
    file_error: 'Unable to read or parse the cookie file.',
    network_error: 'Unable to connect to Bilibili. Check your network connection.',
    timeout: 'Cookie verification timed out. Please try again.',
    rate_limited: 'Bilibili is temporarily limiting requests. Please try again later.',
    server_error: 'Bilibili server error. Cookie validity could not be verified.',
    unknown: 'Unable to determine cookie status. Check the logs for details.',
  });
  const known = new Set(Object.keys(messages));

  function normalize(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'none' || value === 'checking' || known.has(value)) return value;
    return 'unknown';
  }

  function label(status, username = '', message = '') {
    const normalized = normalize(status);
    if (normalized === 'none') return 'No Cookies';
    if (normalized === 'checking') return 'Checking account…';
    if (normalized === 'valid' && username) return `Cookie is valid. Logged in as ${username}.`;
    return message || messages[normalized];
  }

  function logLevel(status) {
    const normalized = normalize(status);
    if (normalized === 'valid') return 'SUCCESS';
    if (normalized === 'rate_limited') return 'WARN';
    return 'ERROR';
  }

  return Object.freeze({ label, logLevel, messages, normalize });
}));
