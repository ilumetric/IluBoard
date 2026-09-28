// Three-way merge of boards, card by card and field by field: `base` is the
// file as the browser last read it, `mine` the browser's edited board,
// `theirs` the file on disk now (changed by an agent or git pull).
// A field changed on one side only takes that side; changed on both sides to
// different values keeps mine and is reported as a conflict. Pure module.

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const byId = (doc) => new Map((Array.isArray(doc?.cards) ? doc.cards : []).filter((c) => c && typeof c.id === 'string').map((c) => [c.id, c]));

/** Merge two edits of one object against its base; returns { value, conflicts: [key] }. */
function mergeObject(b = {}, m = {}, t = {}) {
  const value = {};
  const conflicts = [];
  const keys = [...new Set([...Object.keys(m), ...Object.keys(t), ...Object.keys(b)])];
  for (const k of keys) {
    const mc = !same(b[k], m[k]);
    const tc = !same(b[k], t[k]);
    let v;
    if (mc && tc && !same(m[k], t[k])) {
      // bookkeeping fields follow the side that wins the content
      if (k !== 'updated' && k !== 'updated_by' && k !== 'order') conflicts.push(k);
      v = m[k];
    } else v = mc ? m[k] : t[k];
    if (v !== undefined) value[k] = v;
  }
  return { value, conflicts };
}

/**
 * { doc, conflicts: [{ id, fields }], notes: [{ id, kind }] }
 * notes: 'deleted-edited' (deleted on one side, edited on the other: kept),
 *        'added-both' (same new id on both sides with different content: mine kept).
 */
export function merge3(base, mine, theirs) {
  const B = byId(base);
  const M = byId(mine);
  const T = byId(theirs);
  const cards = [];
  const conflicts = [];
  const notes = [];

  // Card order in the result: mine first (keeps the human's arrangement), then cards only in theirs.
  const ids = [...M.keys(), ...[...T.keys()].filter((id) => !M.has(id))];
  for (const id of ids) {
    const b = B.get(id);
    const m = M.get(id);
    const t = T.get(id);
    if (!b) {
      // added on one or both sides
      if (m && t && !same(m, t)) notes.push({ id, kind: 'added-both' });
      cards.push(m || t);
      continue;
    }
    if (!m || !t) {
      // deleted on one side: stays deleted unless the other side edited it
      const other = m || t;
      if (!same(b, other)) { notes.push({ id, kind: 'deleted-edited' }); cards.push(other); }
      continue;
    }
    const r = mergeObject(b, m, t);
    if (r.conflicts.length) conflicts.push({ id, fields: r.conflicts });
    cards.push(r.value);
  }

  const top = mergeObject(
    { ...(base || {}), cards: undefined, meta: undefined },
    { ...(mine || {}), cards: undefined, meta: undefined },
    { ...(theirs || {}), cards: undefined, meta: undefined },
  );
  const meta = mergeObject(isObj(base?.meta) ? base.meta : {}, isObj(mine?.meta) ? mine.meta : {}, isObj(theirs?.meta) ? theirs.meta : {});
  const doc = { ...top.value, meta: meta.value, cards };
  const boardConflicts = [...top.conflicts, ...meta.conflicts.filter((k) => k !== 'updated').map((k) => `meta.${k}`)];
  if (boardConflicts.length) conflicts.push({ id: null, fields: boardConflicts });
  return { doc, conflicts, notes };
}
