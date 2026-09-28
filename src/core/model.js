// board.json: constants, normalisation, validation, canonical serialisation and
// the few edits both the browser and the CLI make (move, add, set).
// Pure ES module: no DOM, no Node APIs, no dependencies.

export const FORMAT = 'iluboard';
export const VERSION = 1;
export const DEFAULT_COLUMNS = ['idea', 'todo', 'doing', 'done', 'dropped'];
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'];
export const SIZES = ['S', 'M', 'L', 'XL'];
export const UPDATED_BY = ['human', 'agent'];
/** Columns whose cards must say when they are done. */
export const NEEDS_DONE_WHEN = ['todo', 'doing'];
/** Columns whose cards are finished (no overdue warnings). */
export const CLOSED_COLUMNS = ['done', 'dropped'];

export const TOP_KEYS = ['format', 'version', 'meta', 'columns', 'cards'];
export const META_KEYS = ['title', 'id_prefix', 'updated'];
export const CARD_KEYS = ['id', 'title', 'column', 'order', 'priority', 'size', 'owner', 'goal', 'done_when', 'notes', 'tags', 'due', 'updated', 'updated_by'];
/** Card fields a person or agent edits as text (everything but id / column / order / bookkeeping). */
export const EDITABLE_KEYS = ['title', 'priority', 'size', 'owner', 'goal', 'done_when', 'notes', 'tags', 'due'];

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

/** Local calendar date as YYYY-MM-DD. */
export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** A fresh board. */
export function emptyBoard(title = 'Board', date = today()) {
  return { format: FORMAT, version: VERSION, meta: { title, updated: date }, columns: [...DEFAULT_COLUMNS], cards: [] };
}

/** JSON.parse with the line and column of a syntax error in the message. */
export function parse(text) {
  const src = String(text).replace(/^﻿/, '');
  try {
    return JSON.parse(src);
  } catch (e) {
    const m = String(e.message).match(/position (\d+)/);
    if (m) {
      const before = src.slice(0, Number(m[1]));
      const line = before.split('\n').length;
      const col = before.length - before.lastIndexOf('\n');
      throw new SyntaxError(`invalid JSON at line ${line}, column ${col}: ${e.message}`);
    }
    throw new SyntaxError(`invalid JSON: ${e.message}`);
  }
}

/**
 * A board object from text or an object (deep copy). Fills in a missing
 * `meta`, `columns` or `cards` so the rest of the code can rely on them; it
 * never "fixes" wrong values — `validate` reports those.
 */
export function normalize(input) {
  const doc = typeof input === 'string' ? parse(input) : clone(input);
  if (!isObj(doc)) throw new TypeError('board must be a JSON object');
  if (doc.meta === undefined) doc.meta = {};
  if (doc.columns === undefined) doc.columns = [...DEFAULT_COLUMNS];
  if (doc.cards === undefined) doc.cards = [];
  return doc;
}

// ---- validation ------------------------------------------------------------

/** Issue texts by code, English and Russian. `{x}` is replaced from params. */
export const MESSAGES = {
  en: {
    not_object: 'the board must be a JSON object',
    format: 'format must be "iluboard"',
    version: 'unsupported version {value} (this tool reads version 1)',
    meta: 'meta must be an object',
    meta_string: 'meta.{key} must be a string',
    columns: 'columns must be a non-empty array of strings',
    column_dup: 'column "{value}" is listed twice',
    cards: 'cards must be an array',
    card: 'a card must be an object',
    id_missing: 'card has no id',
    id_format: 'id "{value}" may only contain letters, digits, "_", "." and "-"',
    id_dup: 'id "{value}" is used by more than one card',
    title_missing: 'card {id} has no title',
    column_missing: 'card {id} has no column',
    column_unknown: 'card {id}: column "{value}" is not in columns',
    order: 'card {id}: order must be a whole number ≥ 0',
    priority: 'card {id}: priority must be one of P0, P1, P2, P3',
    size: 'card {id}: size must be one of S, M, L, XL',
    updated_by: 'card {id}: updated_by must be "human" or "agent"',
    string: 'card {id}: {key} must be a string',
    date: '{where}{key} must be a date YYYY-MM-DD (got "{value}")',
    tags: 'card {id}: tags must be an array of strings',
    done_when: 'card {id} is in "{value}" but has no done_when (required for todo and doing)',
    unknown_field: 'card {id}: unknown field "{key}" (kept as is; custom fields should start with x_)',
    unknown_top: 'unknown top-level field "{key}" (kept as is; custom fields should start with x_)',
    unknown_meta: 'unknown field meta.{key} (kept as is; custom fields should start with x_)',
  },
  ru: {
    not_object: 'доска должна быть JSON-объектом',
    format: 'format должен быть "iluboard"',
    version: 'неподдерживаемая версия {value} (поддерживается версия 1)',
    meta: 'meta должна быть объектом',
    meta_string: 'meta.{key} должно быть строкой',
    columns: 'columns — непустой массив строк',
    column_dup: 'колонка "{value}" указана дважды',
    cards: 'cards должен быть массивом',
    card: 'карточка должна быть объектом',
    id_missing: 'у карточки нет id',
    id_format: 'id "{value}": допустимы буквы, цифры, "_", "." и "-"',
    id_dup: 'id "{value}" встречается у нескольких карточек',
    title_missing: 'у карточки {id} нет title',
    column_missing: 'у карточки {id} нет column',
    column_unknown: 'карточка {id}: колонки "{value}" нет в columns',
    order: 'карточка {id}: order — целое число ≥ 0',
    priority: 'карточка {id}: priority — одно из P0, P1, P2, P3',
    size: 'карточка {id}: size — одно из S, M, L, XL',
    updated_by: 'карточка {id}: updated_by — "human" или "agent"',
    string: 'карточка {id}: {key} должно быть строкой',
    date: '{where}{key} — дата в формате ГГГГ-ММ-ДД (сейчас "{value}")',
    tags: 'карточка {id}: tags — массив строк',
    done_when: 'карточка {id} в колонке "{value}", но без done_when (обязателен для todo и doing)',
    unknown_field: 'карточка {id}: неизвестное поле "{key}" (сохранено как есть; свои поля — с префиксом x_)',
    unknown_top: 'неизвестное поле верхнего уровня "{key}" (сохранено; свои поля — с префиксом x_)',
    unknown_meta: 'неизвестное поле meta.{key} (сохранено; свои поля — с префиксом x_)',
  },
};

export function issueText(issue, lang = 'en') {
  const table = MESSAGES[lang] || MESSAGES.en;
  const tpl = table[issue.code] || MESSAGES.en[issue.code] || issue.code;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (issue[k] === undefined ? '' : String(issue[k])));
}

/**
 * Check a board. Returns { ok, errors, warnings }; each issue is
 * { code, path, ...params } — turn it into text with issueText(issue, lang).
 * Errors make `ok` false; warnings (unknown fields) do not.
 */
export function validate(doc) {
  const errors = [];
  const warnings = [];
  const err = (code, path, params = {}) => errors.push({ code, path, ...params });
  const warn = (code, path, params = {}) => warnings.push({ code, path, ...params });

  if (!isObj(doc)) {
    err('not_object', '');
    return { ok: false, errors, warnings };
  }
  if (doc.format !== FORMAT) err('format', 'format', { value: doc.format });
  if (doc.version !== VERSION) err('version', 'version', { value: JSON.stringify(doc.version) });
  for (const k of Object.keys(doc)) if (!TOP_KEYS.includes(k) && !k.startsWith('x_')) warn('unknown_top', k, { key: k });

  if (doc.meta !== undefined && !isObj(doc.meta)) err('meta', 'meta');
  else if (doc.meta) {
    for (const k of ['title', 'id_prefix']) {
      if (doc.meta[k] !== undefined && typeof doc.meta[k] !== 'string') err('meta_string', `meta.${k}`, { key: k });
    }
    if (doc.meta.updated !== undefined && !isDate(doc.meta.updated)) err('date', 'meta.updated', { where: 'meta.', key: 'updated', value: doc.meta.updated });
    for (const k of Object.keys(doc.meta)) if (!META_KEYS.includes(k) && !k.startsWith('x_')) warn('unknown_meta', `meta.${k}`, { key: k });
  }

  let columns = [];
  if (!Array.isArray(doc.columns) || !doc.columns.length || doc.columns.some((c) => typeof c !== 'string' || !c)) {
    err('columns', 'columns');
  } else {
    columns = doc.columns;
    const seen = new Set();
    for (const c of columns) {
      if (seen.has(c)) err('column_dup', 'columns', { value: c });
      seen.add(c);
    }
  }

  if (!Array.isArray(doc.cards)) {
    err('cards', 'cards');
    return { ok: errors.length === 0, errors, warnings };
  }
  const ids = new Map();
  doc.cards.forEach((c, i) => {
    const p = `cards[${i}]`;
    if (!isObj(c)) { err('card', p); return; }
    const id = typeof c.id === 'string' && c.id ? c.id : `#${i}`;
    if (typeof c.id !== 'string' || !c.id) err('id_missing', `${p}.id`, { id });
    else if (!ID_RE.test(c.id)) err('id_format', `${p}.id`, { id, value: c.id });
    else ids.set(c.id, (ids.get(c.id) || 0) + 1);

    if (typeof c.title !== 'string' || !c.title.trim()) err('title_missing', `${p}.title`, { id });
    if (c.column === undefined) err('column_missing', `${p}.column`, { id });
    else if (columns.length && !columns.includes(c.column)) err('column_unknown', `${p}.column`, { id, value: c.column });
    if (c.order !== undefined && !(Number.isInteger(c.order) && c.order >= 0)) err('order', `${p}.order`, { id });
    if (c.priority !== undefined && !PRIORITIES.includes(c.priority)) err('priority', `${p}.priority`, { id });
    if (c.size !== undefined && !SIZES.includes(c.size)) err('size', `${p}.size`, { id });
    if (c.updated_by !== undefined && !UPDATED_BY.includes(c.updated_by)) err('updated_by', `${p}.updated_by`, { id });
    for (const k of ['owner', 'goal', 'done_when', 'notes']) {
      if (c[k] !== undefined && typeof c[k] !== 'string') err('string', `${p}.${k}`, { id, key: k });
    }
    for (const k of ['due', 'updated']) {
      if (c[k] !== undefined && !isDate(c[k])) err('date', `${p}.${k}`, { where: `${id}: `, key: k, value: c[k] });
    }
    if (c.tags !== undefined && (!Array.isArray(c.tags) || c.tags.some((t) => typeof t !== 'string'))) err('tags', `${p}.tags`, { id });
    if (NEEDS_DONE_WHEN.includes(c.column) && !(typeof c.done_when === 'string' && c.done_when.trim())) {
      err('done_when', `${p}.done_when`, { id, value: c.column });
    }
    for (const k of Object.keys(c)) if (!CARD_KEYS.includes(k) && !k.startsWith('x_')) warn('unknown_field', `${p}.${k}`, { id, key: k });
  });
  for (const [id, n] of ids) if (n > 1) err('id_dup', 'cards', { id, value: id });

  return { ok: errors.length === 0, errors, warnings };
}

// ---- canonical form ----------------------------------------------------------

const empty = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/** Known keys in their fixed order, then the rest (x_ and unknown) in their original order. */
function orderKeys(obj, known, dropEmpty) {
  const out = {};
  for (const k of known) if (k in obj && !(dropEmpty && empty(obj[k]))) out[k] = obj[k];
  for (const k of Object.keys(obj)) if (!known.includes(k) && obj[k] !== undefined) out[k] = obj[k];
  return out;
}

/**
 * The canonical board: stable key order, empty optional fields dropped, cards
 * sorted by column (in `columns` order) then `order`, and `order` renumbered
 * 0, 1, 2… inside each column. Returns a new object.
 */
export function canonical(input) {
  const doc = normalize(input);
  const columns = Array.isArray(doc.columns) ? doc.columns : [];
  let cards = Array.isArray(doc.cards) ? doc.cards : doc.cards;
  if (Array.isArray(cards)) {
    const colIndex = (c) => {
      const i = columns.indexOf(c?.column);
      return i < 0 ? columns.length : i;
    };
    const ord = (c) => (Number.isFinite(c?.order) ? c.order : Number.MAX_SAFE_INTEGER);
    cards = cards
      .map((c, i) => ({ c, i }))
      .sort((a, b) => colIndex(a.c) - colIndex(b.c)
        || (colIndex(a.c) === columns.length ? String(a.c?.column).localeCompare(String(b.c?.column)) : 0)
        || ord(a.c) - ord(b.c)
        || a.i - b.i)
      .map(({ c }) => c);
    const counters = new Map();
    cards = cards.map((c) => {
      if (!isObj(c)) return c;
      const n = counters.get(c.column) || 0;
      counters.set(c.column, n + 1);
      if (typeof c.title === 'string') c.title = c.title.trim();
      if (Array.isArray(c.tags)) c.tags = c.tags.filter((t) => !(typeof t === 'string' && !t.trim()));
      return orderKeys({ ...c, order: n }, CARD_KEYS, true);
    });
  }
  const out = orderKeys({ ...doc, cards }, TOP_KEYS, false);
  if (isObj(out.meta)) out.meta = orderKeys(out.meta, META_KEYS, true);
  return out;
}

const isPrimitive = (v) => v === null || typeof v !== 'object';

/** JSON text of a value; arrays of primitives stay on one line. */
function fmtValue(v, indent) {
  if (isPrimitive(v)) return JSON.stringify(v);
  const pad = '  '.repeat(indent + 1);
  const end = '  '.repeat(indent);
  if (Array.isArray(v)) {
    if (!v.length) return '[]';
    if (v.every(isPrimitive)) return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
    return `[\n${v.map((x) => pad + fmtValue(x, indent + 1)).join(',\n')}\n${end}]`;
  }
  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  if (!keys.length) return '{}';
  return `{\n${keys.map((k) => `${pad}${JSON.stringify(k)}: ${fmtValue(v[k], indent + 1)}`).join(',\n')}\n${end}}`;
}

/** The board as canonical text: one field per line, trailing newline. */
export function serialize(doc) {
  return `${fmtValue(canonical(doc), 0)}\n`;
}

// ---- queries and edits ---------------------------------------------------------

export const findCard = (doc, id) => doc.cards.find((c) => c && c.id === id) || null;

/** Cards of one column in board order. */
export function cardsIn(doc, column) {
  return doc.cards
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => c && c.column === column)
    .sort((a, b) => (a.c.order ?? Infinity) - (b.c.order ?? Infinity) || a.i - b.i)
    .map(({ c }) => c);
}

/** Renumber `order` 0, 1, 2… for the given cards (already in the wanted order). */
function renumber(list) {
  list.forEach((c, i) => { c.order = i; });
}

/** Mark a card as changed now by `by` ('human' | 'agent'). */
export function touch(card, by, date = today()) {
  card.updated = date;
  card.updated_by = by;
}

/**
 * The prefix of new ids: meta.id_prefix, else the most common letter prefix of
 * the existing ids, else "B".
 */
export function idPrefix(doc) {
  if (typeof doc.meta?.id_prefix === 'string' && doc.meta.id_prefix) return doc.meta.id_prefix;
  const count = new Map();
  for (const c of doc.cards) {
    const m = typeof c?.id === 'string' && c.id.match(/^(.*?)(\d+)$/);
    if (m && m[1]) count.set(m[1], (count.get(m[1]) || 0) + 1);
  }
  let best = 'B';
  let n = 0;
  for (const [p, k] of count) if (k > n) { best = p; n = k; }
  return best;
}

/** Next free id with a prefix: prefix + (largest number used with it + 1). */
export function nextId(doc, prefix = idPrefix(doc)) {
  const esc = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}(\\d+)$`);
  let max = 0;
  for (const c of doc.cards) {
    const m = typeof c?.id === 'string' && c.id.match(re);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (findCard(doc, `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Move a card to `column` at `index` (0 = top; omitted or out of range = bottom).
 * Renumbers both columns. Marks the card touched when its column or position changed.
 * Returns the card; throws when the card or column does not exist.
 */
export function moveCard(doc, id, column, index, { by = 'human', date = today() } = {}) {
  const card = findCard(doc, id);
  if (!card) throw new Error(`no card "${id}"`);
  if (!doc.columns.includes(column)) throw new Error(`no column "${column}" (columns: ${doc.columns.join(', ')})`);
  const from = card.column;
  const before = cardsIn(doc, column).indexOf(card);
  const source = cardsIn(doc, from).filter((c) => c !== card);
  const target = from === column ? source : cardsIn(doc, column);
  const at = index === undefined || index === null || index < 0 || index > target.length ? target.length : index;
  target.splice(at, 0, card);
  card.column = column;
  if (from !== column) renumber(source);
  renumber(target);
  if (from !== column || before !== at) touch(card, by, date);
  return card;
}

/** Clean a user-supplied field value; '' / [] mean "remove the field". */
function cleanField(key, value) {
  if (key === 'tags') {
    const list = Array.isArray(value) ? value : String(value ?? '').split(',');
    return list.map((t) => String(t).trim()).filter(Boolean);
  }
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Set fields of a card; an empty value removes the field. Marks the card
 * touched when anything changed. Returns the list of changed keys.
 */
export function setFields(doc, id, fields, { by = 'human', date = today() } = {}) {
  const card = findCard(doc, id);
  if (!card) throw new Error(`no card "${id}"`);
  const changed = [];
  for (const [key, raw] of Object.entries(fields)) {
    if (key === 'id' || key === 'column' || key === 'order' || key === 'updated' || key === 'updated_by') continue;
    const value = cleanField(key, raw);
    const before = JSON.stringify(card[key]);
    if (empty(value)) delete card[key];
    else card[key] = value;
    if (JSON.stringify(card[key]) !== before) changed.push(key);
  }
  if (changed.length) touch(card, by, date);
  return changed;
}

/**
 * Add a card. `fields.id` is optional (nextId); `fields.column` defaults to the
 * first column; the card goes to the bottom of its column unless `index` is given.
 */
export function addCard(doc, fields, { by = 'human', date = today(), index } = {}) {
  const id = fields.id ? String(fields.id).trim() : nextId(doc);
  if (!ID_RE.test(id)) throw new Error(`bad id "${id}" (letters, digits, "_", "." and "-")`);
  if (findCard(doc, id)) throw new Error(`id "${id}" is already used`);
  const column = fields.column || doc.columns[0];
  if (!doc.columns.includes(column)) throw new Error(`no column "${column}" (columns: ${doc.columns.join(', ')})`);
  const card = { id, title: '', column, order: cardsIn(doc, column).length };
  for (const [k, v] of Object.entries(fields)) {
    if (k === 'id' || k === 'column' || k === 'order') continue;
    const value = cleanField(k, v);
    if (!empty(value)) card[k] = value;
  }
  touch(card, by, date);
  doc.cards.push(card);
  if (index !== undefined && index !== null) moveCard(doc, id, column, index, { by, date });
  return card;
}

/** Remove a card; renumbers its column. Returns the removed card. */
export function removeCard(doc, id) {
  const card = findCard(doc, id);
  if (!card) throw new Error(`no card "${id}"`);
  doc.cards.splice(doc.cards.indexOf(card), 1);
  renumber(cardsIn(doc, card.column));
  return card;
}
