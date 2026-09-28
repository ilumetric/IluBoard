// The board in words: `text` (one line per card, for agents) and `md`
// (Markdown tables, e.g. for backlog.md). Pure module.

import { CLOSED_COLUMNS, cardsIn } from './model.js';

export const COLUMN_LABELS = {
  ru: { idea: 'идея', todo: 'к работе', doing: 'в работе', done: 'готово', dropped: 'отменено' },
  en: { idea: 'idea', todo: 'to do', doing: 'doing', done: 'done', dropped: 'dropped' },
};

const WORDS = {
  ru: {
    due: 'до', cards: (n) => `${n} ${plural(n, 'карточка', 'карточки', 'карточек')}`, updated: 'обновлено',
    empty: '(пусто)', goal: 'веха', doneWhen: 'готово, когда', notes: 'заметки', tags: 'теги', by: 'правка',
    task: 'Задача', size: 'Размер', owner: 'Кто', due2: 'Срок', exported: 'Экспорт', noEdit: 'не править руками',
  },
  en: {
    due: 'due', cards: (n) => `${n} card${n === 1 ? '' : 's'}`, updated: 'updated',
    empty: '(empty)', goal: 'goal', doneWhen: 'done when', notes: 'notes', tags: 'tags', by: 'last edit',
    task: 'Task', size: 'Size', owner: 'Owner', due2: 'Due', exported: 'Exported', noEdit: 'do not edit by hand',
  },
};

export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export const words = (lang) => WORDS[lang] || WORDS.en;
export const columnLabel = (column, lang = 'ru') => (COLUMN_LABELS[lang] || COLUMN_LABELS.en)[column] || column;

/** "B8 [P0/M] max — Title (до 2026-10-12)" */
export function cardLine(card, lang = 'ru') {
  const tag = [card.priority, card.size].filter(Boolean).join('/');
  let s = card.id;
  if (tag) s += ` [${tag}]`;
  if (card.owner) s += ` ${card.owner}`;
  s += ` — ${card.title || ''}`;
  if (card.due) s += ` (${words(lang).due} ${card.due})`;
  return s;
}

/** Keep the requested columns (all when none are given), in board order. */
function pickColumns(doc, only) {
  if (!only || !only.length) return doc.columns;
  return doc.columns.filter((c) => only.includes(c));
}

/**
 * The board as text: a header line, then per column a "## label (id) — n" line
 * and one line per card. `full` adds goal / done_when / notes / tags below each card.
 */
export function boardText(doc, { lang = 'ru', full = false, columns } = {}) {
  const w = words(lang);
  const out = [];
  const title = doc.meta?.title || 'Board';
  const upd = doc.meta?.updated ? `, ${w.updated} ${doc.meta.updated}` : '';
  out.push(`# ${title} — ${w.cards(doc.cards.length)}${upd}`);
  for (const col of pickColumns(doc, columns)) {
    const list = cardsIn(doc, col);
    out.push('', `## ${columnLabel(col, lang)} (${col}) — ${list.length}`);
    if (!list.length) out.push(w.empty);
    for (const c of list) {
      out.push(`- ${cardLine(c, lang)}`);
      if (!full) continue;
      const extra = [];
      if (c.goal) extra.push(`${w.goal}: ${c.goal}`);
      if (c.done_when) extra.push(`${w.doneWhen}: ${c.done_when}`);
      if (c.notes) extra.push(`${w.notes}: ${c.notes.replace(/\s*\n\s*/g, ' / ')}`);
      if (c.tags?.length) extra.push(`${w.tags}: ${c.tags.join(', ')}`);
      if (c.updated) extra.push(`${w.by}: ${c.updated}${c.updated_by ? ` ${c.updated_by}` : ''}`);
      for (const e of extra) out.push(`  ${e}`);
    }
  }
  return `${out.join('\n')}\n`;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>');

/**
 * Markdown export: a title, a generated-file note, and a table per column
 * (id · task · P · size · owner · goal · done when · due).
 */
export function boardMarkdown(doc, { lang = 'ru', columns, source = 'board.json' } = {}) {
  const w = words(lang);
  const out = [];
  out.push(`# ${doc.meta?.title || 'Board'}`);
  out.push('');
  out.push(`> ${w.exported}: \`${source}\`${doc.meta?.updated ? ` · ${w.updated} ${doc.meta.updated}` : ''} · ${w.noEdit} (\`node iluboard.mjs md ${source}\`)`);
  for (const col of pickColumns(doc, columns)) {
    const list = cardsIn(doc, col);
    out.push('', `## ${capital(columnLabel(col, lang))} · ${list.length}`, '');
    if (!list.length) { out.push(`_${w.empty}_`); continue; }
    const closed = CLOSED_COLUMNS.includes(col);
    out.push(`| id | ${w.task} | P | ${w.size} | ${w.owner} | ${capital(w.goal)} | ${capital(w.doneWhen)} | ${w.due2} |`);
    out.push('|---|---|---|---|---|---|---|---|');
    for (const c of list) {
      const title = closed && col === 'dropped' ? `~~${cell(c.title)}~~` : cell(c.title);
      out.push(`| ${cell(c.id)} | ${title} | ${cell(c.priority)} | ${cell(c.size)} | ${cell(c.owner)} | ${cell(c.goal)} | ${cell(c.done_when)} | ${cell(c.due)} |`);
    }
  }
  return `${out.join('\n')}\n`;
}

const capital = (s) => s.charAt(0).toUpperCase() + s.slice(1);
