// What changed between two versions of a board: cards moved between columns,
// added, removed, edited; columns reordered inside; meta and columns changes.
// Pure module.

import { CARD_KEYS, cardsIn } from './model.js';
import { columnLabel, cardLine } from './text.js';

// `order` shows up as reordering; `updated` / `updated_by` change with every edit.
const IGNORED = new Set(['id', 'column', 'order', 'updated', 'updated_by']);

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const cardsOf = (doc) => (Array.isArray(doc?.cards) ? doc.cards.filter((c) => c && typeof c.id === 'string') : []);

/**
 * Compare boards `a` (before) and `b` (after).
 * { moved: [{id, title, from, to, by}], added: [card], removed: [card],
 *   changed: [{id, title, by, fields: [{key, from, to}]}], reordered: [column],
 *   meta: [{key, from, to}], columns: {from, to} | null, empty: boolean }
 */
export function diffBoards(a, b) {
  const before = new Map(cardsOf(a).map((c) => [c.id, c]));
  const after = new Map(cardsOf(b).map((c) => [c.id, c]));
  const moved = [];
  const added = [];
  const removed = [];
  const changed = [];

  for (const [id, c] of after) {
    const old = before.get(id);
    if (!old) { added.push(c); continue; }
    if (old.column !== c.column) moved.push({ id, title: c.title, from: old.column, to: c.column, by: c.updated_by });
    const keys = [...new Set([...CARD_KEYS, ...Object.keys(old), ...Object.keys(c)])].filter((k) => !IGNORED.has(k));
    const fields = keys.filter((k) => !same(old[k], c[k])).map((k) => ({ key: k, from: old[k], to: c[k] }));
    if (fields.length) changed.push({ id, title: c.title, by: c.updated_by, fields });
  }
  for (const [id, c] of before) if (!after.has(id)) removed.push(c);

  // Reordered columns: the relative order of cards that were in the column before and after differs.
  const reordered = [];
  const colsB = Array.isArray(b?.columns) ? b.columns : [];
  for (const col of colsB) {
    const was = safeCardsIn(a, col).map((c) => c.id);
    const now = safeCardsIn(b, col).map((c) => c.id);
    const common = new Set(was.filter((id) => now.includes(id)));
    const x = was.filter((id) => common.has(id));
    const y = now.filter((id) => common.has(id));
    if (!same(x, y)) reordered.push(col);
  }

  const meta = [];
  const ma = a?.meta || {};
  const mb = b?.meta || {};
  for (const k of [...new Set([...Object.keys(ma), ...Object.keys(mb)])]) {
    if (k !== 'updated' && !same(ma[k], mb[k])) meta.push({ key: k, from: ma[k], to: mb[k] });
  }
  const columns = same(a?.columns, b?.columns) ? null : { from: a?.columns, to: b?.columns };

  const empty = !moved.length && !added.length && !removed.length && !changed.length && !reordered.length && !meta.length && !columns;
  return { moved, added, removed, changed, reordered, meta, columns, empty };
}

function safeCardsIn(doc, col) {
  if (!Array.isArray(doc?.cards)) return [];
  return cardsIn({ cards: cardsOf(doc) }, col);
}

const DIFF_WORDS = {
  ru: {
    none: 'Изменений нет.', moved: 'Перенесены', added: 'Новые', removed: 'Удалены', changed: 'Изменены',
    reordered: 'Порядок изменён', meta: 'Доска', columns: 'Колонки', in: 'в', was: 'было', empty: 'пусто',
  },
  en: {
    none: 'No changes.', moved: 'Moved', added: 'Added', removed: 'Removed', changed: 'Changed',
    reordered: 'Reordered', meta: 'Board', columns: 'Columns', in: 'in', was: 'was', empty: 'empty',
  },
};

const short = (v, emptyWord) => {
  if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) return `(${emptyWord})`;
  const s = Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
  const one = s.replace(/\s*\n\s*/g, ' / ');
  return `"${one.length > 80 ? `${one.slice(0, 79)}…` : one}"`;
};

/** The diff as Markdown-ish text. */
export function diffText(d, { lang = 'ru' } = {}) {
  const w = DIFF_WORDS[lang] || DIFF_WORDS.en;
  if (d.empty) return `${w.none}\n`;
  const out = [];
  const section = (title, lines) => {
    if (!lines.length) return;
    if (out.length) out.push('');
    out.push(`## ${title} (${lines.length})`, '', ...lines);
  };
  const col = (c) => columnLabel(c, lang);
  const by = (x) => (x ? ` · ${x}` : '');
  section(w.moved, d.moved.map((m) => `- ${m.id} ${m.title}: ${col(m.from)} → ${col(m.to)}${by(m.by)}`));
  section(w.added, d.added.map((c) => `- ${cardLine(c, lang)} — ${w.in} «${col(c.column)}»${by(c.updated_by)}`));
  section(w.removed, d.removed.map((c) => `- ${cardLine(c, lang)} — ${w.was} ${w.in} «${col(c.column)}»`));
  section(w.changed, d.changed.map((c) => `- ${c.id} ${c.title}${by(c.by)}: ${c.fields.map((f) => `${f.key} ${short(f.from, w.empty)} → ${short(f.to, w.empty)}`).join('; ')}`));
  if (d.reordered.length) section(w.reordered, [`- ${d.reordered.map(col).join(', ')}`]);
  const boardLines = d.meta.map((m) => `- meta.${m.key}: ${short(m.from, w.empty)} → ${short(m.to, w.empty)}`);
  if (d.columns) boardLines.push(`- ${w.columns}: ${(d.columns.from || []).join(', ')} → ${(d.columns.to || []).join(', ')}`);
  section(w.meta, boardLines);
  return `${out.join('\n')}\n`;
}

/** One short line: "2 moved, 1 added" — for toasts. */
export function diffSummary(d, lang = 'ru') {
  const w = DIFF_WORDS[lang] || DIFF_WORDS.en;
  if (d.empty) return w.none.replace(/\.$/, '');
  const parts = [];
  if (d.moved.length) parts.push(`${w.moved.toLowerCase()}: ${d.moved.length}`);
  if (d.added.length) parts.push(`${w.added.toLowerCase()}: ${d.added.length}`);
  if (d.removed.length) parts.push(`${w.removed.toLowerCase()}: ${d.removed.length}`);
  if (d.changed.length) parts.push(`${w.changed.toLowerCase()}: ${d.changed.length}`);
  if (!parts.length && d.reordered.length) parts.push(w.reordered.toLowerCase());
  if (!parts.length) parts.push(w.meta.toLowerCase());
  return parts.join(', ');
}
