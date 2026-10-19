// Compatibility: files written by newer or older tools, board settings in meta,
// and column edits. Older CLIs keep unknown keys and only warn about them, so a
// new optional key must never turn into an error, and the canonical text of a
// file must not depend on which version wrote it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  emptyBoard, normalize, validate, serialize, addCard, columnConf, needsDoneWhen, isClosed, metaList,
  addColumn, moveColumn, removeColumn, setColumnConf,
} from '../src/core/model.js';
import { merge3 } from '../src/core/merge.js';
import { boardText } from '../src/core/text.js';
import { diffBoards, diffText } from '../src/core/diff.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** A board as a newer IluBoard might write it: settings and fields this version may not know. */
function futureBoard() {
  const doc = emptyBoard('Future', '2026-10-20');
  doc.meta.owners = ['max', 'anna'];
  doc.meta.goals = ['3a'];
  doc.meta.columns = {
    todo: { label: 'Backlog', color: 'blue', x_note: 'kept' },
    doing: { wip: 2, sparkle: true, color: 'teal' },
  };
  doc.meta.x_theme = { a: 1 };
  doc.meta.timezone = 'Europe/Riga';
  doc.x_top = 1;
  doc.automations = [{ when: 'done', then: 'archive' }];
  addCard(doc, { title: 'A', column: 'todo', done_when: 'x', x_points: 3 }, { date: '2026-10-20' });
  doc.cards[0].links = ['B9'];
  return doc;
}

test('a board from a newer version: no errors, every unknown key survives, canonical text is stable', () => {
  const text = serialize(futureBoard());
  const doc = normalize(text);
  const v = validate(doc);
  assert.equal(v.ok, true, JSON.stringify(v.errors));
  assert.ok(v.warnings.length > 0, 'unknown things are reported as warnings');
  assert.equal(serialize(doc), text, 'idempotent');
  assert.deepEqual(doc.meta.columns.todo.x_note, 'kept');
  assert.equal(doc.meta.columns.doing.sparkle, true);
  assert.deepEqual(doc.automations, [{ when: 'done', then: 'archive' }]);
  assert.deepEqual(doc.cards[0].links, ['B9']);
  assert.equal(doc.cards[0].x_points, 3);
});

test('new meta keys come after the old ones, so older tools write the same canonical text', () => {
  // older versions: known keys [title, id_prefix, updated] first, then the rest in their original order
  const OLD = ['title', 'id_prefix', 'updated'];
  const meta = normalize(serialize(futureBoard())).meta;
  const keys = Object.keys(meta);
  const oldOrder = [...OLD.filter((k) => k in meta), ...keys.filter((k) => !OLD.includes(k))];
  assert.deepEqual(keys, oldOrder);
});

test('merge keeps fields only one side knows about', () => {
  const base = futureBoard();
  const mine = normalize(base);
  const theirs = normalize(base);
  mine.cards[0].title = 'A (mine)';
  theirs.cards[0].x_points = 5;
  theirs.meta.columns.todo.color = 'green';
  const r = merge3(base, mine, theirs);
  assert.equal(r.doc.cards[0].title, 'A (mine)');
  assert.equal(r.doc.cards[0].x_points, 5);
  assert.deepEqual(r.doc.cards[0].links, ['B9']);
  assert.equal(r.doc.meta.columns.todo.color, 'green');
  assert.deepEqual(r.conflicts, []);
});

test('meta.columns: settings are read leniently and only warned about', () => {
  const doc = futureBoard();
  assert.deepEqual(columnConf(doc, 'todo'), { label: 'Backlog', color: 'blue' });
  assert.deepEqual(columnConf(doc, 'doing'), { wip: 2 }, 'unknown colour ignored');
  assert.deepEqual(columnConf(doc, 'idea'), {});
  doc.meta.columns = { doing: { wip: 0, done_when: 'yes' }, ghost: {} };
  const v = validate(doc);
  assert.equal(v.ok, true);
  assert.deepEqual(v.warnings.map((w) => w.code).filter((c) => c.startsWith('mcol')).sort(), ['mcol_flag', 'mcol_unknown', 'mcol_wip']);
  doc.meta.columns = 'nope';
  assert.equal(validate(doc).ok, true);
  assert.ok(validate(doc).warnings.some((w) => w.code === 'mcol'));
});

test('column rules only add to the built-in ones', () => {
  const doc = emptyBoard('T', '2026-10-20');
  addColumn(doc, 'review', { index: 3, done_when: true });
  addColumn(doc, 'shipped', { closed: true });
  setColumnConf(doc, 'todo', { done_when: false }); // cannot switch the built-in rule off
  assert.equal(needsDoneWhen(doc, 'review'), true);
  assert.equal(needsDoneWhen(doc, 'todo'), true);
  assert.equal(needsDoneWhen(doc, 'idea'), false);
  assert.equal(isClosed(doc, 'shipped'), true);
  assert.equal(isClosed(doc, 'done'), true);
  addCard(doc, { id: 'B1', title: 'X', column: 'review' });
  assert.deepEqual(validate(doc).errors.map((e) => e.code), ['done_when']);
  doc.meta.columns.todo = { done_when: false };
  assert.ok(validate(doc).warnings.some((w) => w.code === 'mcol_builtin'));
});

test('column edits: add, move, configure, remove; meta.columns follows the column order', () => {
  const doc = emptyBoard('T', '2026-10-20');
  addColumn(doc, 'review', { index: 3, label: ' На ревью ', color: 'pink', wip: 2 });
  assert.deepEqual(doc.columns, ['idea', 'todo', 'doing', 'review', 'done', 'dropped']);
  assert.deepEqual(doc.meta.columns.review, { label: 'На ревью', color: 'pink', wip: 2 });
  setColumnConf(doc, 'idea', { color: 'yellow' });
  assert.deepEqual(Object.keys(doc.meta.columns), ['idea', 'review']);
  moveColumn(doc, 'review', 0);
  assert.deepEqual(Object.keys(doc.meta.columns), ['review', 'idea']);
  doc.meta.columns.review.x_owner = 'max';
  setColumnConf(doc, 'review', { label: 'Review', color: 'nope', wip: -1 });
  assert.deepEqual(doc.meta.columns.review, { label: 'Review', x_owner: 'max' }, 'bad values dropped, x_ kept');
  setColumnConf(doc, 'idea', {});
  assert.deepEqual(Object.keys(doc.meta.columns), ['review']);
  assert.throws(() => addColumn(doc, 'review'), /already exists/);
  assert.throws(() => addColumn(doc, 'bad id'), /bad column id/);
  addCard(doc, { id: 'B1', title: 'X', column: 'review' });
  assert.throws(() => removeColumn(doc, 'review'), /not empty/);
  doc.cards = [];
  removeColumn(doc, 'review');
  assert.equal(doc.meta.columns, undefined, 'no empty meta.columns left behind');
  assert.equal(validate(doc).ok, true);
  assert.match(serialize(doc), /"columns": \["idea", "todo", "doing", "done", "dropped"\]/);
});

test('meta.owners / meta.goals are suggestion lists', () => {
  const doc = futureBoard();
  assert.deepEqual(metaList(doc, 'owners'), ['max', 'anna']);
  doc.meta.owners = ['max', 1, ' anna ', 'max'];
  assert.deepEqual(metaList(doc, 'owners'), ['max', 'anna']);
  assert.ok(validate(doc).warnings.some((w) => w.code === 'meta_list'));
  doc.meta.owners = [];
  assert.doesNotMatch(serialize(doc), /"owners"/, 'empty lists are dropped');
});

test('text and diff use the board\'s own column names', () => {
  const before = futureBoard();
  const after = normalize(before);
  after.cards[0].column = 'doing';
  after.cards[0].order = 0;
  assert.match(boardText(after, { lang: 'en' }), /## Backlog \(todo\) — 0/);
  assert.match(diffText(diffBoards(before, after), { lang: 'en' }), /Backlog → doing/);
});

for (const cliPath of ['tools/iluboard.mjs', 'iluboard.mjs']) {
  const run = (...args) => {
    const r = spawnSync(process.execPath, [join(ROOT, cliPath), ...args], { encoding: 'utf8' });
    return { code: r.status, out: r.stdout, err: r.stderr };
  };

  test(`${cliPath}: a value from a newer version is an error with a hint to update`, () => {
    const file = join(mkdtempSync(join(tmpdir(), 'iluboard-')), 'board.json');
    const doc = futureBoard();
    doc.cards[0].priority = 'P4';
    writeFileSync(file, serialize(doc));
    const v = run('validate', file, '--lang', 'en');
    assert.equal(v.code, 1);
    assert.match(v.out, /hint: the file may come from a newer IluBoard/);
    const s = run('set', file, 'B1', '--title', 'Y', '--lang', 'en');
    assert.equal(s.code, 1);
    assert.match(s.err, /hint: the file may come from a newer IluBoard/);
  });

  test(`${cliPath}: board settings are warnings, the board stays writable`, () => {
    const file = join(mkdtempSync(join(tmpdir(), 'iluboard-')), 'board.json');
    writeFileSync(file, serialize(futureBoard()));
    const v = run('validate', file, '--lang', 'en');
    assert.equal(v.code, 0);
    assert.match(v.out, /unknown colour "teal"/);
    assert.equal(run('set', file, 'B1', '--title', 'Y').code, 0);
    const t = run('text', file, '--lang', 'en');
    assert.match(t.out, /## Backlog \(todo\)/);
  });
}
