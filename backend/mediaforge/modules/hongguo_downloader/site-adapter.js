'use strict';

const { safeFetch, validateRemoteUrl } = require('./network');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 MediaForge/1.1';
const PAGE_PATTERN = /^\/(?:voddetail\/(\d+)|vodplay\/(\d+)-(\d+)-(\d+))\.html$/;

function decodeHtml(value = '') {
  return String(value)
    .replace(/<[^>]*>/g, '')
    .replace(/&#(x?[0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(parseInt(code.replace(/^x/i, ''), code[0].toLowerCase() === 'x' ? 16 : 10)))
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ').trim();
}

function parseAttributes(value = '') {
  const attributes = {};
  for (const match of value.matchAll(/(?:^|,)([A-Z0-9-]+)=(?:"([^"]*)"|([^,]*))/gi)) {
    attributes[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function normalizeHongguoUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch { throw new Error('Enter a valid Hongguo series or episode URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !['hongguoapp.cn', 'www.hongguoapp.cn'].includes(url.hostname.toLowerCase())) {
    throw new Error('Only HTTPS URLs from hongguoapp.cn are supported.');
  }
  const match = url.pathname.match(PAGE_PATTERN);
  if (!match) throw new Error('Use a Hongguo series (/voddetail/) or episode (/vodplay/) URL.');
  url.protocol = 'https:';
  url.hostname = 'www.hongguoapp.cn';
  url.port = '';
  url.search = '';
  url.hash = '';
  return url.href;
}

function pageIdentity(value) {
  const url = new URL(normalizeHongguoUrl(value));
  const match = url.pathname.match(PAGE_PATTERN);
  return {
    id: match[1] || match[2],
    source: match[3] ? Number(match[3]) : null,
    episode: match[4] ? Number(match[4]) : null,
    kind: match[1] ? 'series' : 'episode'
  };
}

async function fetchText(url, { siteOnly = true, signal } = {}) {
  const response = await safeFetch(url, {
    siteOnly, signal,
    headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/vnd.apple.mpegurl,*/*' }
  });
  if (!response.ok) throw new Error(`Hongguo returned HTTP ${response.status}.`);
  return response.text();
}

function parseStructuredData(html) {
  for (const match of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const value = JSON.parse(match[1]);
      if (value && typeof value === 'object') return value;
    } catch { /* The visible HTML fallbacks remain available. */ }
  }
  return {};
}

function parseSeriesPage(html, pageUrl, requested = null) {
  const identity = pageIdentity(pageUrl);
  const detailUrl = `https://www.hongguoapp.cn/voddetail/${identity.id}.html`;
  const structured = parseStructuredData(html);
  const titleMatch = html.match(/<h2[^>]*class=["'][^"']*hl-dc-title[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  const coverMatch = html.match(/data-original=["'](https:[^"']+)["']/i);
  const title = decodeHtml(structured.name || titleMatch?.[1] || `Hongguo ${identity.id}`);
  const coverUrl = structured.thumbnailUrl || coverMatch?.[1] || '';
  const candidates = new Map();
  const linkPattern = new RegExp(`<a\\b([^>]*?)href=["']([^"']*\\/vodplay\\/${identity.id}-(\\d+)-(\\d+)\\.html)["']([^>]*)>([\\s\\S]*?)<\\/a>`, 'gi');
  for (const match of html.matchAll(linkPattern)) {
    const source = Number(match[3]);
    const number = Number(match[4]);
    const label = decodeHtml(match[6]) || `Episode ${String(number).padStart(2, '0')}`;
    if (!candidates.has(source)) candidates.set(source, new Map());
    candidates.get(source).set(number, {
      id: `${identity.id}-${source}-${number}`,
      seriesId: identity.id,
      source,
      number,
      title: label === '全集' ? title : label,
      url: new URL(match[2], detailUrl).href,
      detailUrl,
      seriesTitle: title,
      coverUrl,
      selected: true,
      status: 'Ready',
      resolution: '', size: null, progress: 0, speed: 0, eta: ''
    });
  }
  if (!candidates.size) throw new Error('No public episode links were found. The website layout may have changed.');
  const preferredSource = requested?.source && candidates.has(requested.source)
    ? requested.source
    : [...candidates.entries()].sort((a, b) => b[1].size - a[1].size)[0][0];
  let episodes = [...candidates.get(preferredSource).values()].sort((a, b) => a.number - b.number);
  if (requested?.kind === 'episode') {
    episodes = episodes.filter((episode) => episode.number === requested.episode);
    if (!episodes.length) throw new Error(`Episode ${requested.episode} was not found in the public playlist.`);
  }
  return {
    series: {
      id: identity.id, title, coverUrl,
      description: decodeHtml(structured.description || ''),
      url: detailUrl, totalEpisodes: episodes.length
    },
    episodes
  };
}

function decodePlayerUrl(player) {
  let value = String(player.url || '');
  if (Number(player.encrypt) === 1) value = decodeURIComponent(value);
  if (Number(player.encrypt) === 2) value = decodeURIComponent(Buffer.from(value, 'base64').toString('utf8'));
  return value;
}

function parseMasterPlaylist(text, playlistUrl) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const variants = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].startsWith('#EXT-X-STREAM-INF:')) continue;
    const attributes = parseAttributes(lines[index].slice(lines[index].indexOf(':') + 1));
    const resolutionMatch = lines[index].match(/RESOLUTION=(\d+)x(\d+)/i);
    const bandwidthMatch = lines[index].match(/(?:AVERAGE-)?BANDWIDTH=(\d+)/i);
    const next = lines.slice(index + 1).find((line) => !line.startsWith('#'));
    if (!next) continue;
    const width = Number(resolutionMatch?.[1] || 0);
    const height = Number(resolutionMatch?.[2] || 0);
    variants.push({
      type: 'hls', url: new URL(next, playlistUrl).href,
      width, height, resolution: width && height ? `${width}x${height}` : '',
      quality: width && height ? `${Math.min(width, height)}p` : 'Unknown',
      bitrate: Number(bandwidthMatch?.[1] || attributes.bandwidth || 0),
      codecs: attributes.codecs || ''
    });
  }
  return variants;
}

class HongguoSiteAdapter {
  supports(url) { try { normalizeHongguoUrl(url); return true; } catch { return false; } }

  async getSeriesInfo(url, { signal } = {}) {
    const normalized = normalizeHongguoUrl(url);
    const requested = pageIdentity(normalized);
    const detailUrl = `https://www.hongguoapp.cn/voddetail/${requested.id}.html`;
    const html = await fetchText(detailUrl, { signal });
    return parseSeriesPage(html, detailUrl, requested);
  }

  async getEpisodes(url, options) { return (await this.getSeriesInfo(url, options)).episodes; }

  async getMediaSources(episode, { signal } = {}) {
    const html = await fetchText(episode.url, { signal });
    const match = html.match(/\bvar\s+player_aaaa\s*=\s*(\{[\s\S]*?\})\s*<\/script>/i);
    if (!match) throw new Error('No public player source was found. The website player may have changed.');
    let player;
    try { player = JSON.parse(match[1]); } catch { throw new Error('The Hongguo player data is malformed.'); }
    if (player.trysee && Number(player.trysee) > 0) throw new Error('This episode is preview-only and cannot be downloaded legitimately.');
    const mediaUrl = decodePlayerUrl(player);
    await validateRemoteUrl(mediaUrl);
    const lower = new URL(mediaUrl).pathname.toLowerCase();
    if (lower.endsWith('.m3u8')) {
      const playlist = await fetchText(mediaUrl, { siteOnly: false, signal });
      const variants = parseMasterPlaylist(playlist, mediaUrl);
      if (variants.length) return variants;
      if (!playlist.includes('#EXTM3U')) throw new Error('The media source is not a valid HLS playlist.');
      return [{ type: 'hls', url: mediaUrl, width: 0, height: 0, resolution: '', quality: 'Unknown', bitrate: 0, codecs: '' }];
    }
    if (lower.endsWith('.mpd')) return [{ type: 'dash', url: mediaUrl, resolution: '', quality: 'Unknown', bitrate: 0 }];
    if (/\.(?:mp4|m4v|mov|webm|mkv)$/.test(lower)) return [{ type: 'http', url: mediaUrl, resolution: '', quality: 'Unknown', bitrate: 0 }];
    throw new Error('The public player uses an unsupported media source.');
  }
}

module.exports = {
  HongguoSiteAdapter, USER_AGENT, decodeHtml, normalizeHongguoUrl,
  pageIdentity, parseMasterPlaylist, parseSeriesPage
};
