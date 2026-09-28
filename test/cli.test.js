import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EXAMPLE = join(ROOT, 'examples/board.json');

// Run every check against the source CLI and the single-file bundle.
for (const cliPath of ['tools/iluboard.mjs', 'iluboard.mjs']) {
  const run = (...args) => {
    const r = spawnSync(process.execPath, [join(ROOT, cliPath), ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };
  const tmp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'iluboard-'));
    const file = join(dir, 'board.json');
    copyFileSync(EXAMPLE, file);
    return { dir, file };
  };

  test(`${cliPath}: --version, --help, unknown command`, () => {
    assert.match(run('--version').out, /^iluboard \d+\.\d+\.\d+ \(board format v1\)/);
    assert.match(run('--help').out, /Usage: node iluboard\.mjs/);
    assert.equal(run('frobnicate').code, 2);
  });

  test(`${cliPath}: text, md, validate, fmt --check`, () => {
    const t = run('text', EXAMPLE);
    assert.equal(t.code, 0);
    assert.match(t.out, /- B8 \[P0\/M\] max — Тест пайплайна: ковш → Substance без high-poly \(до 2026-10-12\)/);
    assert.match(run('md', EXAMPLE, '--lang', 'en').out, /\| id \| Task \| P \|/);
    assert.match(run('validate', EXAMPLE).out, /ok \(10 cards\)/);
    assert.equal(run('fmt', EXAMPLE, '--check').code, 0);
  });

  test(`${cliPath}: move / add / set write a valid canonical file`, () => {
    const { dir, file } = tmp();
    try {
      assert.equal(run('move', file, 'B8', 'done', '--top').code, 0);
      let doc = JSON.parse(readFileSync(file, 'utf8'));
      const b8 = doc.cards.find((c) => c.id === 'B8');
      assert.equal(b8.column, 'done');
      assert.equal(b8.order, 0);
      assert.equal(b8.updated_by, 'agent');

      // todo needs done_when: refused, file untouched
      const before = readFileSync(file, 'utf8');
      const bad = run('add', file, '--title', 'No criterion', '--column', 'todo');
      assert.equal(bad.code, 1);
      assert.match(bad.err, /done_when/);
      assert.equal(readFileSync(file, 'utf8'), before);

      const ok = run('add', file, '--title', 'With criterion', '--column', 'todo', '--done-when', 'It works', '--priority', 'P2', '--tags', 'a,b');
      assert.equal(ok.code, 0, ok.err);
      assert.match(ok.out, /added B15 → todo/);
      assert.equal(run('set', file, 'B15', '--owner', 'max', '--priority', '').code, 0);
      doc = JSON.parse(readFileSync(file, 'utf8'));
      const b15 = doc.cards.find((c) => c.id === 'B15');
      assert.equal(b15.owner, 'max');
      assert.equal('priority' in b15, false);
      assert.deepEqual(b15.tags, ['a', 'b']);

      assert.equal(run('move', file, 'B12', 'doing').code, 1, 'no done_when → refused');
      assert.equal(run('move', file, 'B12', 'doing', '--done-when', 'Photo mode ships').code, 0);
      assert.equal(run('validate', file).code, 0);
      assert.equal(run('fmt', file, '--check').code, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${cliPath}: validate fails with exit 1 and --json`, () => {
    const { dir, file } = tmp();
    try {
      const doc = JSON.parse(readFileSync(file, 'utf8'));
      doc.cards[1].id = doc.cards[0].id;
      writeFileSync(file, JSON.stringify(doc));
      const r = run('validate', file, '--json');
      assert.equal(r.code, 1);
      const j = JSON.parse(r.out);
      assert.equal(j.ok, false);
      assert.equal(j.errors[0].code, 'id_dup');
      assert.equal(run('fmt', file, '--check').code, 1);
      assert.equal(run('fmt', file).code, 0);
      assert.equal(run('fmt', file, '--check').code, 0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${cliPath}: diff two files and diff --git`, () => {
    const { dir, file } = tmp();
    try {
      const git = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      git('init', '-q');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'add', 'board.json');
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
      assert.match(run('diff', file, '--git').out, /Изменений нет/);
      run('move', file, 'B8', 'done');
      run('add', file, '--title', 'Fresh', '--column', 'idea');
      const d = run('diff', file, '--git', '--lang', 'en');
      assert.equal(d.code, 0);
      assert.match(d.out, /## Moved \(1\)\n\n- B8 .*: doing → done · agent/);
      assert.match(d.out, /## Added \(1\)/);
      const j = JSON.parse(run('diff', file, '--git', 'HEAD', '--json').out);
      assert.equal(j.moved[0].id, 'B8');
      assert.match(run('diff', EXAMPLE, file).out, /Перенесены \(1\)/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test(`${cliPath}: init refuses to overwrite`, () => {
    const { dir, file } = tmp();
    try {
      assert.equal(run('init', file).code, 2);
      const fresh = join(dir, 'new.board.json');
      assert.equal(run('init', fresh, '--title', 'X', '--prefix', 'T').code, 0);
      assert.equal(run('add', fresh, '--title', 'first').code, 0);
      assert.equal(JSON.parse(readFileSync(fresh, 'utf8')).cards[0].id, 'T1');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
