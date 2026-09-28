import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emptyBoard, normalize, validate, serialize, canonical, cardsIn, moveCard, addCard, setFields, removeCard,
  nextId, idPrefix, isDate, issueText, parse,
} from '../src/core/model.js';

const demo = () => normalize(readFileSync(new URL('../examples/board.json', import.meta.url), 'utf8'));
const codes = (doc) => validate(doc).errors.map((e) => e.code);

test('the example board is valid and canonical', () => {
  const text = readFileSync(new URL('../examples/board.json', import.meta.url), 'utf8');
  const doc = normalize(text);
  assert.equal(validate(doc).ok, true);
  assert.equal(serialize(doc), text);
});

test('serialize: stable key order, one field per line, inline arrays, trailing newline', () => {
  const doc = emptyBoard('T', '2026-09-28');
  doc.cards.push({ updated_by: 'agent', tags: ['a', 'b'], title: 'X', column: 'idea', id: 'B1', x_custom: { a: 1 }, order: 5 });
  const text = serialize(doc);
  assert.match(text, /"columns": \["idea", "todo", "doing", "done", "dropped"\]/);
  assert.match(text, /"tags": \["a", "b"\]/);
  const keys = [...text.matchAll(/^ {6}"(\w+)":/gm)].map((m) => m[1]);
  assert.deepEqual(keys, ['id', 'title', 'column', 'order', 'tags', 'updated_by', 'x_custom']);
  assert.match(text, /"order": 0/);
  assert.ok(text.endsWith('}\n'));
  assert.equal(serialize(normalize(text)), text, 'idempotent');
});

test('canonical: cards sorted by column then order, order renumbered, empty fields dropped', () => {
  const doc = emptyBoard();
  doc.cards = [
    { id: 'A', title: 'a', column: 'done', order: 7 },
    { id: 'B', title: 'b', column: 'idea', order: 3, notes: '', tags: [] },
    { id: 'C', title: 'c', column: 'idea', order: 1 },
  ];
  const c = canonical(doc);
  assert.deepEqual(c.cards.map((x) => `${x.id}${x.order}`), ['C0', 'B1', 'A0']);
  assert.equal('notes' in c.cards[1], false);
  assert.equal('tags' in c.cards[1], false);
});

test('unknown fields survive a round trip', () => {
  const doc = demo();
  doc.cards[0].x_estimate = 3;
  doc.cards[0].weird = 'kept';
  doc.x_board = { a: [1, { b: 2 }] };
  const back = normalize(serialize(doc));
  assert.equal(back.cards.find((c) => c.id === doc.cards[0].id).x_estimate, 3);
  assert.equal(back.cards.find((c) => c.id === doc.cards[0].id).weird, 'kept');
  assert.deepEqual(back.x_board, { a: [1, { b: 2 }] });
  const v = validate(back);
  assert.equal(v.ok, true);
  assert.deepEqual(v.warnings.map((w) => w.code), ['unknown_field']);
});

test('validate: the rules from the spec', () => {
  const doc = demo();
  doc.cards[0].id = doc.cards[1].id;
  doc.cards[2].column = 'later';
  doc.cards[3].priority = 'P9';
  doc.cards[4].size = 'XXL';
  doc.cards[5].due = '2026-02-30';
  doc.cards[6].updated_by = 'robot';
  const todo = doc.cards.find((c) => c.column === 'todo');
  delete todo.done_when;
  const got = codes(doc);
  for (const c of ['id_dup', 'column_unknown', 'priority', 'size', 'date', 'updated_by', 'done_when']) assert.ok(got.includes(c), `${c} in ${got}`);
  assert.equal(validate({ format: 'x', version: 2, columns: [], cards: {} }).ok, false);
  assert.deepEqual(codes({ format: 'x', version: 2, columns: [], cards: {} }), ['format', 'version', 'columns', 'cards']);
});

test('issue texts exist in both languages', () => {
  const doc = demo();
  doc.cards[0].priority = 'P7';
  const [e] = validate(doc).errors;
  assert.match(issueText(e, 'en'), /priority must be one of/);
  assert.match(issueText(e, 'ru'), /priority — одно из/);
});

test('isDate', () => {
  assert.equal(isDate('2026-10-12'), true);
  assert.equal(isDate('2026-13-01'), false);
  assert.equal(isDate('2026-1-01'), false);
});

test('moveCard between columns and inside a column, renumbering and touching', () => {
  const doc = demo();
  moveCard(doc, 'B8', 'done', 0, { by: 'agent', date: '2027-01-01' });
  assert.deepEqual(cardsIn(doc, 'done').map((c) => c.id), ['B8', 'B5', 'B4']);
  assert.deepEqual(cardsIn(doc, 'done').map((c) => c.order), [0, 1, 2]);
  assert.deepEqual(cardsIn(doc, 'doing').map((c) => [c.id, c.order]), [['B7', 0]]);
  const b8 = doc.cards.find((c) => c.id === 'B8');
  assert.equal(b8.updated, '2027-01-01');
  assert.equal(b8.updated_by, 'agent');
  moveCard(doc, 'B4', 'done', 0, { date: '2027-01-02' });
  assert.deepEqual(cardsIn(doc, 'done').map((c) => c.id), ['B4', 'B8', 'B5']);
  const b5 = doc.cards.find((c) => c.id === 'B5');
  const before = b5.updated;
  moveCard(doc, 'B5', 'done', 99);
  assert.equal(b5.updated, before, 'no change → not touched');
  assert.throws(() => moveCard(doc, 'B5', 'nope'), /no column/);
  assert.throws(() => moveCard(doc, 'NOPE', 'done'), /no card/);
});

test('addCard, setFields, removeCard', () => {
  const doc = demo();
  assert.equal(idPrefix(doc), 'B');
  assert.equal(nextId(doc), 'B15');
  const c = addCard(doc, { title: ' New ', column: 'todo', done_when: 'x', tags: 'a, b,,', owner: '' }, { by: 'agent', date: '2027-01-01' });
  assert.equal(c.id, 'B15');
  assert.equal(c.title, 'New');
  assert.deepEqual(c.tags, ['a', 'b']);
  assert.equal('owner' in c, false);
  assert.equal(c.order, 3);
  assert.throws(() => addCard(doc, { id: 'B15', title: 'dup' }), /already used/);
  assert.throws(() => addCard(doc, { id: 'bad id', title: 'x' }), /bad id/);
  const top = addCard(doc, { id: 'Z1', title: 'top', column: 'idea' }, { index: 0 });
  assert.equal(cardsIn(doc, 'idea')[0], top);
  assert.deepEqual(setFields(doc, 'B15', { priority: 'P1', notes: '', title: 'New' }, { by: 'human', date: '2027-02-02' }), ['priority']);
  assert.equal(c.updated_by, 'human');
  assert.deepEqual(setFields(doc, 'B15', { priority: '' }), ['priority']);
  assert.equal('priority' in c, false);
  removeCard(doc, 'B15');
  assert.equal(doc.cards.some((x) => x.id === 'B15'), false);
  assert.deepEqual(cardsIn(doc, 'todo').map((x) => x.order), [0, 1, 2]);
});

test('nextId with meta.id_prefix and an inferred prefix', () => {
  const doc = emptyBoard();
  doc.cards = [{ id: 'T3', title: 'a', column: 'idea' }, { id: 'T10', title: 'b', column: 'idea' }, { id: 'X1', title: 'c', column: 'idea' }];
  assert.equal(idPrefix(doc), 'T');
  assert.equal(nextId(doc), 'T11');
  doc.meta.id_prefix = 'Q';
  assert.equal(nextId(doc), 'Q1');
});

test('parse reports line and column', () => {
  assert.throws(() => parse('{\n  "a": 1,\n}'), /line 3/);
});
