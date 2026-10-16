'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');
const { USER_AGENT } = require('./site-adapter');
const { retryAfterMs, safeFetch } = require('./network');

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', aborted); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', aborted);
      reject(signal.reason || new Error('Cancelled.'));
    };
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function sanitizeFilename(value, fallback = 'Untitled') {
  let clean = String(value || fallback)
    .normalize('NFC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '').replace(/\s+/g, ' ').trim();
  if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `_${clean}`;
  return (clean || fallback).slice(0, 180);
}

function formatEta(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  const rounded = Math.round(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const secs = rounded % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function qualityScore(source) {
  return [Math.min(Number(source.width) || 0, Number(source.height) || 0), Number(source.bitrate) || 0];
}

function selectQuality(sources, preference = 'best') {
  if (!Array.isArray(sources) || !sources.length) throw new Error('No downloadable media source is available.');
  const sorted = [...sources].sort((a, b) => {
    const [ap, ab] = qualityScore(a); const [bp, bb] = qualityScore(b);
    return bp - ap || bb - ab;
  });
  if (preference === 'best') return sorted[0];
  const target = Number(String(preference).replace(/p$/i, ''));
  return sorted.find((source) => qualityScore(source)[0] <= target) || sorted.at(-1);
}

function parseMediaPlaylist(text, playlistUrl) {
  if (!text.includes('#EXTM3U')) throw new Error('The HLS playlist is invalid.');
  const keyLines = text.match(/^#EXT-X-KEY:.*$/gim) || [];
  if (keyLines.some((line) => !/METHOD=NONE/i.test(line))) {
    throw new Error('Encrypted or protected HLS is not supported.');
  }
  if (/^#EXT-X-(?:MAP|BYTERANGE):/im.test(text)) {
    throw new Error('Fragmented or byte-range HLS is not supported by the resumable engine.');
  }
  const segments = text.split(/\r?\n/).map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => new URL(line, playlistUrl).href);
  if (!segments.length) throw new Error('The HLS playlist contains no media segments.');
  return segments;
}

async function streamResponse(response, filePath, { append = false, onChunk, signal, waitIfPaused } = {}) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const stream = fs.createWriteStream(filePath, { flags: append ? 'a' : 'w' });
  try {
    for await (const chunk of response.body) {
      if (signal?.aborted) throw signal.reason || new Error('Cancelled.');
      if (waitIfPaused) await waitIfPaused();
      if (!stream.write(chunk)) await once(stream, 'drain');
      onChunk?.(chunk.length);
    }
    stream.end();
    await once(stream, 'finish');
  } catch (error) {
    stream.destroy();
    throw error;
  }
}

class DownloadManager extends EventEmitter {
  constructor({ adapter, processManager, ffmpeg, ffprobe, partialsDirectory }) {
    super();
    Object.assign(this, { adapter, processManager, ffmpeg, ffprobe, partialsDirectory });
    this.paused = false;
    this.cancelled = false;
    this.pauseWaiters = [];
    this.abortController = new AbortController();
    this.processes = new Set();
    this.adaptiveDelayUntil = 0;
    this.adaptiveSegmentLimit = 16;
    this.successSinceLimit = 0;
  }

  async waitIfPaused() {
    if (!this.paused) return;
    await new Promise((resolve) => this.pauseWaiters.push(resolve));
    if (this.cancelled) throw new Error('Cancelled.');
  }

  pause() {
    this.paused = true;
    if (process.platform !== 'win32') for (const managed of this.processes) managed.child?.kill('SIGSTOP');
  }
  resume() {
    this.paused = false;
    if (process.platform !== 'win32') for (const managed of this.processes) managed.child?.kill('SIGCONT');
    this.pauseWaiters.splice(0).forEach((resolve) => resolve());
  }
  async cancel() {
    this.cancelled = true;
    this.resume();
    this.abortController.abort(new Error('Cancelled.'));
    await Promise.all([...this.processes].map((process) => process.terminate()));
  }

  async request(url, options, job) {
    const retries = Math.max(0, Number(job.settings.maxRetries) || 0);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      await this.waitIfPaused();
      if (this.adaptiveDelayUntil > Date.now()) await sleep(this.adaptiveDelayUntil - Date.now(), this.abortController.signal);
      try {
        const timeoutSignal = AbortSignal.timeout(Math.max(1, Number(job.settings.timeoutSeconds)) * 1000);
        const signal = AbortSignal.any([this.abortController.signal, timeoutSignal]);
        const response = await safeFetch(url, {
          ...options, signal,
          headers: { 'user-agent': USER_AGENT, referer: job.episode.url, ...(options?.headers || {}) }
        });
        if (response.ok || response.status === 206) return response;
        const retryable = TRANSIENT_STATUS.has(response.status);
        if (!retryable || attempt === retries) {
          const error = new Error(`Media server returned HTTP ${response.status}.`);
          error.retryable = retryable; error.status = response.status;
          throw error;
        }
        const delay = retryAfterMs(response) || Math.min(30000, 500 * (2 ** attempt) + Math.random() * 500);
        if (response.status === 429) {
          this.adaptiveSegmentLimit = Math.max(1, Math.floor(this.adaptiveSegmentLimit / 2));
          this.adaptiveDelayUntil = Math.max(this.adaptiveDelayUntil, Date.now() + delay);
          this.successSinceLimit = 0;
        }
        this.emit('retry', job, attempt + 1, delay, response.status);
        await sleep(delay, this.abortController.signal);
      } catch (error) {
        if (this.cancelled) throw new Error('Cancelled.');
        if (error.retryable === false || attempt === retries) throw error;
        const delay = Math.min(30000, 500 * (2 ** attempt) + Math.random() * 500);
        this.emit('retry', job, attempt + 1, delay, 0);
        await sleep(delay, this.abortController.signal);
      }
    }
    throw new Error('Download retries exhausted.');
  }

  partialDirectory(job) {
    const key = crypto.createHash('sha256').update(job.id).digest('hex').slice(0, 20);
    return path.join(this.partialsDirectory, key);
  }

  async outputPath(job, extension) {
    const seriesDir = path.resolve(job.settings.outputDir, sanitizeFilename(job.episode.seriesTitle));
    const relative = path.relative(path.resolve(job.settings.outputDir), seriesDir);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('The output path is unsafe.');
    await fsp.mkdir(seriesDir, { recursive: true });
    const number = String(job.episode.number).padStart(3, '0');
    const base = sanitizeFilename(`Episode ${number} - ${job.episode.title}`);
    let output = path.join(seriesDir, `${base}.${extension}`);
    try {
      await fsp.access(output);
      if (job.settings.duplicateHandling === 'skip') return { output, skip: true };
      if (job.settings.duplicateHandling !== 'replace') {
        let suffix = 2;
        while (fs.existsSync(output)) output = path.join(seriesDir, `${base} (${suffix++}).${extension}`);
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { output, skip: false };
  }

  progress(job, completed, total, bytes, startedAt) {
    const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const speed = bytes / elapsed;
    const fraction = total ? completed / total : 0;
    const eta = fraction > 0 && fraction < 1 ? formatEta(elapsed * (1 - fraction) / fraction) : '';
    this.emit('progress', job, { progress: fraction * 100, speed, eta, completed, total });
  }

  async downloadSegment(job, url, partPath, filePath) {
    const retries = Math.max(0, Number(job.settings.maxRetries) || 0);
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let segmentBytes = 0;
      try {
        const response = await this.request(url, {}, job);
        await streamResponse(response, partPath, {
          signal: this.abortController.signal,
          onChunk: (size) => { segmentBytes += size; },
          waitIfPaused: () => this.waitIfPaused()
        });
        await fsp.rename(partPath, filePath);
        return segmentBytes;
      } catch (error) {
        await fsp.rm(partPath, { force: true });
        if (this.cancelled || error.retryable === false || attempt === retries) throw error;
        const delay = Math.min(30000, 500 * (2 ** attempt) + Math.random() * 500);
        this.emit('retry', job, attempt + 1, delay, 0);
        await sleep(delay, this.abortController.signal);
      }
    }
    throw new Error('Segment download retries exhausted.');
  }

  async downloadHls(job, source) {
    const outputInfo = await this.outputPath(job, 'mp4');
    if (outputInfo.skip) return outputInfo.output;
    const response = await this.request(source.url, {}, job);
    const playlist = await response.text();
    const segments = parseMediaPlaylist(playlist, source.url);
    const directory = this.partialDirectory(job);
    const segmentDirectory = path.join(directory, 'segments');
    const manifestStatePath = path.join(directory, 'manifest.json');
    const fingerprint = crypto.createHash('sha256').update(segments.map((value) => new URL(value).pathname).join('\n')).digest('hex');
    try {
      const previous = JSON.parse(await fsp.readFile(manifestStatePath, 'utf8'));
      if (previous.fingerprint !== fingerprint || previous.count !== segments.length) await fsp.rm(segmentDirectory, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof SyntaxError) await fsp.rm(segmentDirectory, { recursive: true, force: true });
      else if (error.code !== 'ENOENT') throw error;
    }
    await fsp.mkdir(segmentDirectory, { recursive: true });
    await fsp.writeFile(manifestStatePath, JSON.stringify({ fingerprint, count: segments.length }), 'utf8');
    const startedAt = Date.now();
    let bytes = 0;
    let completed = 0;
    const pending = [];
    for (let index = 0; index < segments.length; index += 1) {
      const filePath = path.join(segmentDirectory, `${String(index).padStart(7, '0')}.ts`);
      try {
        const stat = await fsp.stat(filePath);
        if (stat.size > 0) { bytes += stat.size; completed += 1; continue; }
      } catch { /* Missing segments are queued below. */ }
      pending.push({ index, url: segments[index], filePath });
    }
    this.progress(job, completed, segments.length, bytes, startedAt);
    let cursor = 0;
    const workerCount = Math.max(1, Math.min(Number(job.settings.segmentConcurrency) || 1, 16, pending.length || 1));
    this.adaptiveSegmentLimit = workerCount;
    const worker = async (workerIndex) => {
      while (cursor < pending.length) {
        await this.waitIfPaused();
        while (workerIndex >= this.adaptiveSegmentLimit && !this.cancelled) await sleep(500, this.abortController.signal);
        if (this.cancelled) throw new Error('Cancelled.');
        const item = pending[cursor++];
        const partPath = `${item.filePath}.part`;
        const segmentBytes = await this.downloadSegment(job, item.url, partPath, item.filePath);
        bytes += segmentBytes;
        completed += 1;
        this.successSinceLimit += 1;
        if (this.successSinceLimit >= 20 && this.adaptiveSegmentLimit < workerCount) {
          this.adaptiveSegmentLimit += 1; this.successSinceLimit = 0;
        }
        this.progress(job, completed, segments.length, bytes, startedAt);
      }
    };
    await Promise.all(Array.from({ length: workerCount }, (_value, index) => worker(index)));
    await this.waitIfPaused();
    this.emit('status', job, 'Merging', `Remuxing ${segments.length} HLS segments with FFmpeg.`);
    const merged = path.join(directory, 'media.ts');
    const outputStream = fs.createWriteStream(merged, { flags: 'w' });
    for (let index = 0; index < segments.length; index += 1) {
      for await (const chunk of fs.createReadStream(path.join(segmentDirectory, `${String(index).padStart(7, '0')}.ts`))) {
        if (!outputStream.write(chunk)) await once(outputStream, 'drain');
      }
    }
    outputStream.end(); await once(outputStream, 'finish');
    const temporaryOutput = `${outputInfo.output}.part.mp4`;
    await this.runProcess(`hongguo-remux-${job.id}`, this.ffmpeg, ['-nostdin', '-y', '-i', merged, '-map', '0', '-c', 'copy', '-movflags', '+faststart', temporaryOutput]);
    await fsp.rename(temporaryOutput, outputInfo.output);
    await fsp.rm(directory, { recursive: true, force: true });
    return outputInfo.output;
  }

  async downloadHttp(job, source) {
    const extension = path.extname(new URL(source.url).pathname).slice(1).toLowerCase() || 'mp4';
    const outputInfo = await this.outputPath(job, ['mp4', 'm4v', 'mov', 'webm', 'mkv'].includes(extension) ? extension : 'mp4');
    if (outputInfo.skip) return outputInfo.output;
    const partPath = `${outputInfo.output}.part`;
    const metadataPath = `${partPath}.json`;
    let existing = 0;
    try { existing = (await fsp.stat(partPath)).size; } catch { /* Start at zero. */ }
    let supportsRange = false; let total = 0; let identity = '';
    try {
      const head = await this.request(source.url, { method: 'HEAD' }, job);
      supportsRange = /bytes/i.test(head.headers.get('accept-ranges') || '');
      total = Number(head.headers.get('content-length') || 0);
      identity = head.headers.get('etag') || head.headers.get('last-modified') || (total ? `size:${total}` : '');
    } catch { /* Some media servers reject HEAD; a normal GET remains valid. */ }
    if (existing && !identity) { await fsp.truncate(partPath, 0); existing = 0; }
    if (existing && identity) {
      let previousIdentity = '';
      try { previousIdentity = JSON.parse(await fsp.readFile(metadataPath, 'utf8')).identity || ''; } catch { /* Missing metadata forces a safe restart. */ }
      if (previousIdentity !== identity || (total && existing > total)) { await fsp.truncate(partPath, 0); existing = 0; }
    }
    if (identity) await fsp.writeFile(metadataPath, JSON.stringify({ identity }), 'utf8');
    if (existing && !supportsRange) { await fsp.truncate(partPath, 0); existing = 0; }
    const startedAt = Date.now(); let received = existing;
    let response;
    try { response = await this.request(source.url, { headers: existing ? { range: `bytes=${existing}-` } : {} }, job); }
    catch (error) {
      if (!existing || error.status !== 416) throw error;
      await fsp.truncate(partPath, 0); existing = 0; received = 0;
      response = await this.request(source.url, {}, job);
    }
    if (existing && response.status !== 206) {
      await fsp.truncate(partPath, 0); existing = 0; received = 0;
      response = await this.request(source.url, {}, job);
    }
    await streamResponse(response, partPath, {
      append: existing > 0,
      signal: this.abortController.signal,
      waitIfPaused: () => this.waitIfPaused(),
      onChunk: (size) => { received += size; this.progress(job, received, total || received, received - existing, startedAt); }
    });
    await fsp.rename(partPath, outputInfo.output);
    await fsp.rm(metadataPath, { force: true });
    return outputInfo.output;
  }

  async downloadDash(job, source) {
    const manifest = await (await this.request(source.url, {}, job)).text();
    if (/<ContentProtection\b/i.test(manifest)) throw new Error('DRM-protected DASH is not supported.');
    const outputInfo = await this.outputPath(job, 'mkv');
    if (outputInfo.skip) return outputInfo.output;
    const temporaryOutput = `${outputInfo.output}.part.mkv`;
    await this.runProcess(`hongguo-dash-${job.id}`, this.ffmpeg, ['-nostdin', '-y', '-i', source.url, '-map', '0', '-c', 'copy', temporaryOutput]);
    await fsp.rename(temporaryOutput, outputInfo.output);
    return outputInfo.output;
  }

  async runProcess(key, executable, args) {
    const managed = this.processManager.runOneShot(key, { executable, args });
    this.processes.add(managed);
    if (this.paused && process.platform !== 'win32') managed.child?.kill('SIGSTOP');
    const lines = [];
    managed.on('line', ({ line }) => { if (lines.length < 80) lines.push(line); });
    const [{ code, signal }] = await once(managed, 'exit');
    this.processes.delete(managed);
    if (code !== 0) throw new Error(`Media tool failed (${signal || `exit ${code}`}): ${lines.slice(-4).join(' ')}`);
    return lines;
  }

  async verify(job, outputPath) {
    this.emit('status', job, 'Verifying', 'Validating output streams with FFprobe.');
    const lines = await this.runProcess(`hongguo-probe-${job.id}`, this.ffprobe, [
      '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,width,height', '-of', 'json', outputPath
    ]);
    let data;
    try { data = JSON.parse(lines.join('\n')); } catch { throw new Error('FFprobe could not validate the downloaded file.'); }
    const streams = Array.isArray(data.streams) ? data.streams : [];
    const duration = Number(data.format?.duration || 0);
    if (!streams.some((stream) => stream.codec_type === 'video') || duration <= 0) throw new Error('The output is missing a valid video stream or duration.');
    const video = streams.find((stream) => stream.codec_type === 'video');
    job.episode.resolution = video?.width && video?.height ? `${video.width}x${video.height}` : job.episode.resolution;
    job.episode.size = Number(data.format?.size || 0) || null;
  }

  async runJob(job) {
    const sources = await this.adapter.getMediaSources(job.episode);
    const source = selectQuality(sources, job.settings.quality);
    job.episode.resolution = source.resolution || source.quality || 'Unknown';
    this.emit('source', job, source, sources);
    let outputPath;
    if (source.type === 'hls') outputPath = await this.downloadHls(job, source);
    else if (source.type === 'http') outputPath = await this.downloadHttp(job, source);
    else if (source.type === 'dash') outputPath = await this.downloadDash(job, source);
    else throw new Error(`Unsupported media type: ${source.type}`);
    await this.verify(job, outputPath);
    return outputPath;
  }
}

module.exports = { DownloadManager, formatEta, parseMediaPlaylist, sanitizeFilename, selectQuality };
