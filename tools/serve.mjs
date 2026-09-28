#!/usr/bin/env node
// IluBoard local server — optional. Serves the web app and a project folder
// and gives the app a tiny file API, so Save writes board.json straight into
// the folder in any browser (also embedded ones, e.g. the Claude app's, where
// the File System Access API cannot write). GitHub Pages works without it.
//
//   node tools/serve.mjs [folder] [--port 8787] [--open Studio/planning/board.json]
//
//   GET  /__iluboard/info            { app, version, folder }
//   GET  /__iluboard/list            { files: [board files] }
//   GET  /__iluboard/stat?path=p     { mtime, size }
//   GET  /__iluboard/file?path=p     the file's text (X-Mtime header)
//   PUT  /__iluboard/file?path=p     write the body (valid JSON, *.json only)
//
// Safety: listens on 127.0.0.1 only; the Host header must be this server (no
// DNS rebinding); writes need the X-IluBoard header (a page on another site
// cannot send it without a CORS preflight, which is never answered); paths
// stay inside the folder, dot folders are off limits, writes are atomic.

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')).version;
const API = '/__iluboard/';
const MAX_BODY = 16 * 1024 * 1024;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'Library', 'Intermediate', 'Saved', 'DerivedDataCache', 'Binaries', 'Content', 'Plugins', '__pycache__']);
const BOARD_RE = /(^|\.)board\.json$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

function parseArgs(argv) {
  const out = { folder: process.cwd(), port: 8787, open: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') out.port = Number(argv[++i]);
    else if (a === '--open') out.open = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else if (!a.startsWith('-')) out.folder = path.resolve(a);
  }
  return out;
}

/** A path inside `root`, or null when it would leave it or enter a dot folder. */
function inside(root, rel) {
  let p;
  try { p = decodeURIComponent(rel); } catch { return null; }
  p = p.replace(/\\/g, '/').replace(/^\/+/, '');
  if (p.split('/').some((seg) => seg === '..' || (seg.startsWith('.') && seg !== '.'))) return null;
  const abs = path.resolve(root, p);
  const r = path.resolve(root);
  if (abs !== r && !abs.startsWith(r + path.sep)) return null;
  return abs;
}

const toPosix = (p) => p.split(path.sep).join('/');

async function listBoards(root) {
  const files = [];
  let seen = 0;
  async function visit(dir, depth) {
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (++seen > 20000 || files.length >= 200) return;
      if (e.name.startsWith('.')) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < 6 && !SKIP_DIRS.has(e.name)) await visit(abs, depth + 1); continue; }
      if (BOARD_RE.test(e.name)) files.push(toPosix(path.relative(root, abs)));
    }
  }
  await visit(root, 0);
  return files.sort();
}

function send(res, status, body, headers = {}) {
  const json = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': json ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(json ? JSON.stringify(body) : body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function api(req, res, url, folder) {
  const name = url.pathname.slice(API.length);
  if (name === 'info' && req.method === 'GET') return send(res, 200, { app: 'iluboard', version: VERSION, folder: path.basename(folder) });
  if (name === 'list' && req.method === 'GET') return send(res, 200, { files: await listBoards(folder) });
  const rel = url.searchParams.get('path') || '';
  const abs = inside(folder, rel);
  if (!rel || !abs) return send(res, 400, { error: 'bad path' });
  if (name === 'stat' && req.method === 'GET') {
    try { const s = await fsp.stat(abs); return send(res, 200, { mtime: s.mtimeMs, size: s.size }); } catch { return send(res, 404, { error: 'not found' }); }
  }
  if (name === 'file' && req.method === 'GET') {
    try {
      const [text, s] = await Promise.all([fsp.readFile(abs, 'utf8'), fsp.stat(abs)]);
      return send(res, 200, text, { 'Content-Type': 'application/json; charset=utf-8', 'X-Mtime': String(s.mtimeMs) });
    } catch { return send(res, 404, { error: 'not found' }); }
  }
  if (name === 'file' && req.method === 'PUT') {
    if (req.headers['x-iluboard'] !== '1') return send(res, 403, { error: 'missing X-IluBoard header' });
    if (!abs.toLowerCase().endsWith('.json')) return send(res, 403, { error: 'only .json files can be written' });
    const text = await readBody(req);
    try { JSON.parse(text); } catch { return send(res, 400, { error: 'not valid JSON' }); }
    await fsp.mkdir(path.dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, abs);
    const s = await fsp.stat(abs);
    console.log(`  saved ${toPosix(path.relative(folder, abs))} (${s.size} bytes)`);
    return send(res, 200, { mtime: s.mtimeMs, size: s.size });
  }
  return send(res, 405, { error: 'method not allowed' });
}

/** The app's own files first, then the project folder. */
async function serveStatic(req, res, url, folder) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'method not allowed');
  let rel = url.pathname;
  if (rel.endsWith('/')) rel += 'index.html';
  for (const root of folder === APP_ROOT ? [APP_ROOT] : [APP_ROOT, folder]) {
    const abs = inside(root, rel);
    if (!abs) continue;
    try {
      const s = await fsp.stat(abs);
      if (s.isDirectory()) { res.writeHead(301, { Location: `${url.pathname}/` }); return res.end(); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': s.size });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(abs).pipe(res);
    } catch { /* next root */ }
  }
  return send(res, 404, 'not found');
}

export function createServer({ folder = process.cwd(), port = 8787 } = {}) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`]);
  return http.createServer(async (req, res) => {
    try {
      if (!hosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, 'forbidden host');
      const url = new URL(req.url, `http://localhost:${port}`);
      if (url.pathname.startsWith(API)) return await api(req, res, url, folder);
      return await serveStatic(req, res, url, folder);
    } catch (e) {
      if (!res.headersSent) send(res, e.status || 500, { error: e.message });
      else res.end();
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('Usage: node tools/serve.mjs [folder] [--port 8787] [--open path/to/board.json]');
    process.exit(0);
  }
  const server = createServer(args);
  server.on('error', (e) => {
    console.error(e.code === 'EADDRINUSE' ? `Port ${args.port} is busy — try --port ${args.port + 1}` : e.message);
    process.exit(1);
  });
  server.listen(args.port, '127.0.0.1', () => {
    const q = args.open ? `?file=${encodeURIComponent(args.open)}` : '';
    console.log(`IluBoard ${VERSION} — http://localhost:${args.port}/${q}`);
    console.log(`  project folder: ${args.folder}`);
    console.log('  Save writes board files into this folder; changes on disk show up in the app.');
  });
}
