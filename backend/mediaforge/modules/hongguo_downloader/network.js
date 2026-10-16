'use strict';

const dns = require('node:dns').promises;
const net = require('node:net');

const dnsCache = new Map();
const SITE_HOSTS = new Set(['hongguoapp.cn', 'www.hongguoapp.cn']);

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const parts = address.split('.').map(Number);
    return parts[0] === 10 || parts[0] === 127 || parts[0] === 0
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || parts[0] >= 224;
  }
  if (family === 6) {
    const value = address.toLowerCase().split('%')[0];
    if (value.startsWith('::ffff:')) return isPrivateAddress(value.slice(7));
    return value === '::' || value === '::1' || value.startsWith('fe8')
      || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
      || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('ff')
      || value.startsWith('2001:db8:');
  }
  return true;
}

async function assertPublicHost(hostname) {
  const cachedUntil = dnsCache.get(hostname);
  if (cachedUntil && cachedUntil > Date.now()) return;
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  if (!records.length || records.some(({ address }) => isPrivateAddress(address))) {
    throw new Error('The media URL resolves to a private or unsupported network address.');
  }
  dnsCache.set(hostname, Date.now() + 5 * 60 * 1000);
}

async function validateRemoteUrl(value, { siteOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new Error('The URL is invalid.'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Only credential-free HTTPS URLs are supported.');
  }
  if (siteOnly && !SITE_HOSTS.has(url.hostname.toLowerCase())) {
    throw new Error('Only hongguoapp.cn URLs are supported.');
  }
  await assertPublicHost(url.hostname);
  return url;
}

async function safeFetch(value, options = {}) {
  const { siteOnly = false, maxRedirects = 5, ...fetchOptions } = options;
  let current = await validateRemoteUrl(value, { siteOnly });
  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    const response = await fetch(current, { ...fetchOptions, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (redirects === maxRedirects) throw new Error('Too many redirects.');
    const location = response.headers.get('location');
    if (!location) throw new Error('The server returned an invalid redirect.');
    current = await validateRemoteUrl(new URL(location, current).href, { siteOnly });
  }
  throw new Error('Unable to fetch the URL.');
}

function retryAfterMs(response) {
  const value = response.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

module.exports = { SITE_HOSTS, isPrivateAddress, retryAfterMs, safeFetch, validateRemoteUrl };
