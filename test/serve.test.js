import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import { createServer } from '../tools/serve.mjs';

test('local server: info, list, read, write, safety checks', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'iluboard-serve-'));
  mkdirSync(join(dir, 'Studio/planning'), { recursive: true });
  copyFileSync(new URL('../examples/board.json', import.meta.url), join(dir, 'Studio/planning/board.json'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const server = createServer({ folder: dir, port });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = `http://127.0.0.1:${port}/__iluboard/`;
  try {
    assert.equal((await (await fetch(`${base}info`)).json()).app, 'iluboard');
    assert.deepEqual((await (await fetch(`${base}list`)).json()).files, ['Studio/planning/board.json']);
    const r = await fetch(`${base}file?path=Studio/planning/board.json`);
    assert.ok(Number(r.headers.get('x-mtime')) > 0);
    assert.match(await r.text(), /"format": "iluboard"/);
    // writes need the header, JSON and a .json path inside the folder
    assert.equal((await fetch(`${base}file?path=Studio/planning/board.json`, { method: 'PUT', body: '{}' })).status, 403);
    assert.equal((await fetch(`${base}file?path=x.txt`, { method: 'PUT', body: '{}', headers: { 'X-IluBoard': '1' } })).status, 403);
    assert.equal((await fetch(`${base}file?path=../x.json`, { method: 'PUT', body: '{}', headers: { 'X-IluBoard': '1' } })).status, 400);
    assert.equal((await fetch(`${base}file?path=a.json`, { method: 'PUT', body: 'nope', headers: { 'X-IluBoard': '1' } })).status, 400);
    const w = await fetch(`${base}file?path=Studio/planning/board.json`, { method: 'PUT', body: '{"format":"iluboard"}\n', headers: { 'X-IluBoard': '1' } });
    assert.equal(w.status, 200);
    assert.equal(readFileSync(join(dir, 'Studio/planning/board.json'), 'utf8'), '{"format":"iluboard"}\n');
    // DNS rebinding guard
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/__iluboard/info', headers: { Host: 'evil.example' } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    assert.equal(status, 403);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
