// Where the board comes from and goes to. A "source" is
//   { kind: 'fsa' | 'server' | 'memory', name, path, writable,
//     read() → { text, mtime }, stat() → mtime | null, write(text) → mtime, handle? }
// 'fsa'    — a file handle from the File System Access API (Chrome, Edge): Save writes the same file.
// 'server' — tools/serve.mjs on localhost: Save writes through its small file API.
// 'memory' — demo, new board or a file opened without the API: Save asks where (or downloads).
// Recent boards (file handles) are remembered in IndexedDB — only the handles, never the board.

export const fsaSupported = () => typeof window !== 'undefined' && 'showOpenFilePicker' in window && 'showDirectoryPicker' in window;

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'Library', 'Intermediate', 'Saved', 'DerivedDataCache', 'Binaries', 'Content', 'Plugins', '__pycache__', 'Temp', 'Logs']);
const MAX_DEPTH = 5;
const MAX_ENTRIES = 6000;
export const isBoardName = (n) => /^board\.json$/i.test(n) || /\.board\.json$/i.test(n);

async function ensurePermission(handle, mode) {
  try {
    if ((await handle.queryPermission?.({ mode })) === 'granted') return true;
    return (await handle.requestPermission?.({ mode })) === 'granted';
  } catch { return false; }
}

/** A source for a FileSystemFileHandle. `path` is a label ("Studio/planning/board.json"). */
export function fsaSource(handle, path = handle.name) {
  return {
    kind: 'fsa',
    name: handle.name,
    path,
    handle,
    writable: true,
    async read() {
      const f = await handle.getFile();
      return { text: await f.text(), mtime: f.lastModified };
    },
    async stat() {
      return (await handle.getFile()).lastModified;
    },
    async write(text) {
      if (!(await ensurePermission(handle, 'readwrite'))) throw new Error('permission');
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return (await handle.getFile()).lastModified;
    },
  };
}

/** A board that is not tied to a file (yet). */
export function memorySource(name = 'board.json', text = null) {
  return {
    kind: 'memory',
    name,
    path: null,
    writable: false,
    async read() { return { text, mtime: null }; },
    async stat() { return null; },
    async write() { throw new Error('no file'); },
  };
}

export async function pickFile() {
  const [handle] = await window.showOpenFilePicker({
    id: 'iluboard',
    types: [{ description: 'IluBoard board.json', accept: { 'application/json': ['.json'] } }],
    excludeAcceptAllOption: false,
  });
  return fsaSource(handle);
}

export async function pickSaveFile(suggestedName = 'board.json') {
  const handle = await window.showSaveFilePicker({
    id: 'iluboard',
    suggestedName,
    types: [{ description: 'IluBoard board.json', accept: { 'application/json': ['.json'] } }],
  });
  return fsaSource(handle);
}

export async function pickFolder() {
  return window.showDirectoryPicker({ id: 'iluboard', mode: 'readwrite' });
}

/**
 * Board files in a folder: Studio/planning/board.json first (a fast path),
 * then a shallow walk that skips VCS / build / Unreal content folders.
 * Returns [{ path, handle }].
 */
export async function findBoards(dir) {
  const found = new Map();
  const tryPath = async (parts) => {
    try {
      let d = dir;
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
      const h = await d.getFileHandle(parts[parts.length - 1]);
      found.set(parts.join('/'), h);
    } catch { /* not there */ }
  };
  await tryPath(['board.json']);
  await tryPath(['Studio', 'planning', 'board.json']);
  let seen = 0;
  async function visit(d, path, level) {
    for await (const [name, h] of d.entries()) {
      if (++seen > MAX_ENTRIES) return;
      if (h.kind === 'directory') {
        if (level < MAX_DEPTH && !SKIP_DIRS.has(name) && !name.startsWith('.')) await visit(h, [...path, name], level + 1);
      } else if (isBoardName(name)) {
        const key = [...path, name].join('/');
        if (!found.has(key)) found.set(key, h);
      }
    }
  }
  await visit(dir, [], 0);
  return [...found].map(([path, handle]) => ({ path: `${dir.name}/${path}`, handle }));
}

/** Create board.json in a folder and return its source. */
export async function createInFolder(dir, text) {
  const handle = await dir.getFileHandle('board.json', { create: true });
  const src = fsaSource(handle, `${dir.name}/board.json`);
  await src.write(text);
  return src;
}

/** Offer a file for download. */
export function download(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Open a file with a plain <input type=file> (browsers without the API). */
export function pickFileFallback() {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const f = input.files?.[0];
      if (!f) return reject(new DOMException('cancelled', 'AbortError'));
      resolve(memorySource(f.name, await f.text()));
    };
    input.click();
  });
}

// ---- local server (tools/serve.mjs) ---------------------------------------------

const API = '__iluboard/';
let serverInfo;

/** { app, version, folder } when the page is served by tools/serve.mjs, else null. */
export async function detectServer() {
  if (serverInfo !== undefined) return serverInfo;
  serverInfo = null;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)) return null;
  try {
    const r = await fetch(`${API}info`, { cache: 'no-store' });
    if (r.ok) {
      const j = await r.json();
      if (j.app === 'iluboard') serverInfo = j;
    }
  } catch { /* plain static server */ }
  return serverInfo;
}

export async function serverList() {
  const r = await fetch(`${API}list`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return (await r.json()).files;
}

export function serverSource(path) {
  const q = `path=${encodeURIComponent(path)}`;
  return {
    kind: 'server',
    name: path.split('/').pop(),
    path,
    writable: true,
    async read() {
      const r = await fetch(`${API}file?${q}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(r.status === 404 ? 'not found' : `HTTP ${r.status}`);
      return { text: await r.text(), mtime: Number(r.headers.get('X-Mtime')) || null };
    },
    async stat() {
      const r = await fetch(`${API}stat?${q}`, { cache: 'no-store' });
      if (!r.ok) throw new Error('not found');
      return (await r.json()).mtime;
    },
    async write(text) {
      const r = await fetch(`${API}file?${q}`, { method: 'PUT', body: text, headers: { 'Content-Type': 'application/json', 'X-IluBoard': '1' } });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
      return (await r.json()).mtime;
    },
  };
}

// ---- recent boards (IndexedDB) ------------------------------------------------------

const DB = 'iluboard';
const STORE = 'recent';
const MAX_RECENT = 12;

function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const res = fn(store);
    t.oncomplete = () => resolve(res?.result ?? res);
    t.onerror = () => reject(t.error);
  });
}

/** [{ key, kind, path, title, at, handle? }] newest first; [] when IndexedDB is unavailable. */
export async function recentList() {
  try {
    const all = await tx('readonly', (s) => s.getAll());
    return (all || []).sort((a, b) => b.at - a.at);
  } catch { return []; }
}

/** Remember a source (fsa: its handle; server: its path). */
export async function remember(source, title) {
  if (source.kind === 'memory') return;
  try {
    const list = await recentList();
    let key = source.kind === 'server' ? `server:${location.host}:${source.path}` : null;
    if (source.kind === 'fsa') {
      for (const r of list) {
        if (r.kind === 'fsa' && r.handle && (await r.handle.isSameEntry?.(source.handle).catch(() => false))) key = r.key;
      }
      key ||= `fsa:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
    }
    const entry = { key, kind: source.kind, path: source.path, title, at: Date.now(), host: location.host };
    if (source.kind === 'fsa') entry.handle = source.handle;
    await tx('readwrite', (s) => s.put(entry));
    const extra = (await recentList()).slice(MAX_RECENT);
    if (extra.length) await tx('readwrite', (s) => extra.forEach((e) => s.delete(e.key)));
  } catch { /* IndexedDB unavailable: no recent list */ }
}

export async function forget(key) {
  try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ }
}

/** A source for a recent entry (asks for permission — call from a click). */
export async function reopen(entry) {
  if (entry.kind === 'server') return serverSource(entry.path);
  if (!(await ensurePermission(entry.handle, 'readwrite'))) {
    if (!(await ensurePermission(entry.handle, 'read'))) throw new Error('permission');
  }
  return fsaSource(entry.handle, entry.path);
}
