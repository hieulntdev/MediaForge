(function initDownloadState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BiliDownloadState = api;
}(typeof globalThis === 'object' ? globalThis : this, () => {
  const MAX_LOG_ROWS = 500;

  function createSnapshot() {
    return {
      revision: 0,
      phase: 'idle',
      paused: false,
      cancelRequested: false,
      input: { links_file: '', output_dir: '', cookies_file: '' },
      items: [],
      rowStates: {},
      activeRow: null,
      activeFraction: 0,
      eta: '',
      account: { status: 'none', username: '', message: '' },
      settings: {},
      logs: [],
    };
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function begin(snapshot, input = {}, { retry = false } = {}) {
    snapshot.revision += 1;
    snapshot.phase = retry ? 'downloading' : 'resolving';
    snapshot.paused = false;
    snapshot.cancelRequested = false;
    snapshot.input = {
      links_file: input.links_file || snapshot.input.links_file || '',
      output_dir: input.output_dir || snapshot.input.output_dir || '',
      cookies_file: input.cookies_file || snapshot.input.cookies_file || '',
    };
    snapshot.activeRow = null;
    snapshot.activeFraction = 0;
    if (!retry) {
      snapshot.items = [];
      snapshot.rowStates = {};
    }
    return snapshot;
  }

  function setControlState(snapshot, control) {
    snapshot.revision += 1;
    if (control === 'pause') {
      snapshot.paused = true;
      for (const rowState of Object.values(snapshot.rowStates)) {
        if (String(rowState.status).toLowerCase() === 'downloading') rowState.speed = 0;
      }
    } else if (control === 'resume') {
      snapshot.paused = false;
    } else if (control === 'cancel') {
      snapshot.cancelRequested = true;
    }
    return snapshot;
  }

  function reduceEvent(snapshot, event, { timestamp = Date.now() } = {}) {
    snapshot.revision += 1;
    const rowKey = event.row == null ? null : String(event.row);
    const addLog = (level, message) => {
      snapshot.logs.push({ timestamp, level, message });
      if (snapshot.logs.length > MAX_LOG_ROWS) {
        snapshot.logs.splice(0, snapshot.logs.length - MAX_LOG_ROWS);
      }
    };
    switch (event.type) {
      case 'log':
        addLog(String(event.level || 'INFO'), String(event.message || ''));
        break;
      case 'account':
        snapshot.account = {
          status: event.status || 'none',
          username: event.username || '',
          message: event.message || '',
        };
        break;
      case 'settings':
        snapshot.settings = clone(event.settings || {});
        break;
      case 'analyze_progress':
        snapshot.phase = 'resolving';
        addLog('INFO', `Resolving ${event.index}/${event.total}: ${event.url}`);
        break;
      case 'analyze_done':
        snapshot.items = clone(event.items || []);
        snapshot.rowStates = Object.fromEntries(
          snapshot.items.map((item) => [String(item.row), { status: 'Queued', detail: '', speed: 0 }]),
        );
        snapshot.activeRow = null;
        snapshot.activeFraction = 0;
        snapshot.phase = 'downloading';
        snapshot.paused = false;
        break;
      case 'analyze_failed':
        snapshot.phase = 'idle';
        snapshot.paused = false;
        addLog('ERROR', String(event.message || 'Analysis failed.'));
        break;
      case 'progress': {
        if (rowKey === null) break;
        snapshot.activeRow = event.row;
        snapshot.activeFraction = Number.isFinite(Number(event.fraction))
          ? Math.max(0, Math.min(1, Number(event.fraction))) : 0;
        const previous = snapshot.rowStates[rowKey] || {};
        if (event.status === 'downloading') {
          snapshot.rowStates[rowKey] = {
            ...previous,
            status: 'Downloading',
            received: Number(event.received) || 0,
            total: Number(event.total) || 0,
            speed: Number.isFinite(Number(event.speed)) && Number(event.speed) >= 0
              ? Number(event.speed) : 0,
          };
          snapshot.eta = event.eta || '';
        } else if (event.status === 'finished') {
          snapshot.rowStates[rowKey] = {
            ...previous, status: 'Processing', detail: 'Processing…', speed: 0,
          };
        }
        break;
      }
      case 'row_update':
        if (rowKey !== null) {
          snapshot.rowStates[rowKey] = {
            ...(snapshot.rowStates[rowKey] || {}),
            status: event.status || 'Queued',
            detail: event.detail || '',
            speed: 0,
          };
          if (event.status === 'Downloading') snapshot.phase = 'downloading';
          const item = snapshot.items.find((value) => Number(value.row) === Number(event.row));
          const prefix = `[${Number(event.row) + 1}/${snapshot.items.length}]`;
          const status = String(event.status || '').toLowerCase();
          if (status === 'downloading') addLog('INFO', `${prefix} Start: ${item?.title || ''}`);
          else if (status === 'done' || status === 'completed') addLog('SUCCESS', `${prefix} Completed: ${item?.title || ''}`);
          else if (status === 'failed') addLog('ERROR', `${prefix} Error: ${event.detail || ''} - ${item?.url || ''}`);
          if (event.row === snapshot.activeRow && ['Done', 'Completed', 'Failed', 'Cancelled'].includes(event.status)) {
            snapshot.activeRow = null;
            snapshot.activeFraction = 0;
          }
        }
        break;
      case 'download_done':
        addLog('INFO', snapshot.cancelRequested ? 'Download cancelled.' : 'All downloads finished.');
        snapshot.eta = '';
        snapshot.phase = 'idle';
        snapshot.paused = false;
        snapshot.activeRow = null;
        snapshot.activeFraction = 0;
        for (const rowState of Object.values(snapshot.rowStates)) rowState.speed = 0;
        break;
      case 'process_exit':
        snapshot.eta = '';
        snapshot.phase = 'idle';
        snapshot.paused = false;
        snapshot.activeRow = null;
        snapshot.activeFraction = 0;
        for (const rowState of Object.values(snapshot.rowStates)) rowState.speed = 0;
        break;
      default:
        break;
    }
    return snapshot;
  }

  function snapshotWithEvent(snapshot, event) {
    const snapshotTimestamp = Date.now();
    reduceEvent(snapshot, event, { timestamp: snapshotTimestamp });
    return { ...event, revision: snapshot.revision, snapshotTimestamp };
  }

  return {
    MAX_LOG_ROWS,
    begin,
    clone,
    createSnapshot,
    reduceEvent,
    setControlState,
    snapshotWithEvent,
  };
}));
