import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalize, moveCard, addCard, setFields, removeCard, serialize } from '../src/core/model.js';
import { diffBoards, diffText, diffSummary } from '../src/core/diff.js';
import { merge3 } from '../src/core/merge.js';
import { boardText, boardMarkdown, cardLine } from '../src/core/text.js';

const demo = () => normalize(readFileSync(new URL('../examples/board.json', import.meta.url), 'utf8'));

test('cardLine matches the format from the spec', () => {
  const b8 = demo().cards.find((c) => c.id === 'B8');
  assert.equal(cardLine(b8), 'B8 [P0/M] max — Тест пайплайна: ковш → Substance без high-poly (до 2026-10-12)');
  assert.equal(cardLine({ id: 'X', title: 't' }, 'en'), 'X — t');
});

test('boardText and boardMarkdown', () => {
  const doc = demo();
  const text = boardText(doc, { full: true });
  assert.match(text, /^# Demo Game — 10 карточек/);
  assert.match(text, /## в работе \(doing\) — 2/);
  assert.match(text, /готово, когда: Макс посмотрел/);
  const md = boardMarkdown(doc, { lang: 'en', columns: ['todo'] });
  assert.match(md, /## To do · 3/);
  assert.match(md, /\| B9 \| Черновик диалогов пролога \| P1 \| M \|/);
  assert.doesNotMatch(md, /B8/);
});

test('diff: moved, added, removed, changed, reordered', () => {
  const a = demo();
  const b = demo();
  moveCard(b, 'B8', 'done', 0, { by: 'human' });
  addCard(b, { id: 'B20', title: 'New', column: 'idea' });
  removeCard(b, 'B3');
  setFields(b, 'B9', { priority: 'P0', notes: 'hi' });
  moveCard(b, 'B11', 'todo', 0);
  const d = diffBoards(a, b);
  assert.deepEqual(d.moved.map((m) => `${m.id}:${m.from}>${m.to}`), ['B8:doing>done']);
  assert.deepEqual(d.added.map((c) => c.id), ['B20']);
  assert.deepEqual(d.removed.map((c) => c.id), ['B3']);
  assert.deepEqual(d.changed.map((c) => [c.id, c.fields.map((f) => f.key)]), [['B9', ['priority', 'notes']]]);
  assert.ok(d.reordered.includes('todo'));
  const text = diffText(d);
  assert.match(text, /## Перенесены \(1\)/);
  assert.match(text, /B8 .*: в работе → готово · human/);
  assert.match(text, /priority "P1" → "P0"/);
  assert.match(diffSummary(d, 'en'), /moved: 1, added: 1, removed: 1, changed: 1/);
  assert.equal(diffBoards(a, demo()).empty, true);
  assert.equal(diffText(diffBoards(a, demo()), { lang: 'en' }), 'No changes.\n');
});

test('merge3: independent edits combine; same-field conflicts keep mine', () => {
  const base = demo();
  const mine = demo();
  const theirs = demo();
  moveCard(mine, 'B11', 'todo', 0, { by: 'human' }); // human reorders todo
  setFields(mine, 'B9', { owner: 'max' }, { by: 'human' });
  setFields(theirs, 'B14', { priority: 'P0' }, { by: 'agent' }); // agent edits another card
  addCard(theirs, { id: 'B30', title: 'Agent card', column: 'idea' }, { by: 'agent' });
  setFields(theirs, 'B9', { owner: 'narrative-team', notes: 'agent note' }, { by: 'agent' });
  removeCard(theirs, 'B3');
  const r = merge3(base, mine, theirs);
  const doc = normalize(r.doc);
  const byId = (id) => doc.cards.find((c) => c.id === id);
  assert.equal(byId('B14').priority, 'P0');
  assert.ok(byId('B30'));
  assert.equal(byId('B3'), undefined);
  assert.equal(byId('B9').owner, 'max', 'conflict → mine');
  assert.equal(byId('B9').notes, 'agent note', 'non-conflicting field from theirs');
  assert.deepEqual(r.conflicts, [{ id: 'B9', fields: ['owner'] }]);
  const todo = doc.cards.filter((c) => c.column === 'todo').sort((x, y) => x.order - y.order).map((c) => c.id);
  assert.deepEqual(todo, ['B11', 'B9', 'B10']);
  assert.ok(serialize(doc));
});

test('merge3: deleted on one side but edited on the other is kept and reported', () => {
  const base = demo();
  const mine = demo();
  const theirs = demo();
  removeCard(mine, 'B12');
  setFields(theirs, 'B12', { notes: 'still needed' });
  const r = merge3(base, mine, theirs);
  assert.ok(r.doc.cards.find((c) => c.id === 'B12'));
  assert.deepEqual(r.notes, [{ id: 'B12', kind: 'deleted-edited' }]);
});
