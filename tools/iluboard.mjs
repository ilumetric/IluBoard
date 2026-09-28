#!/usr/bin/env node
// IluBoard CLI — read, check, describe and edit board.json without a browser.
// Source of the single-file bundle `iluboard.mjs` (npm run bundle).
//
//   node tools/iluboard.mjs --help

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_VERSION } from '../src/core/version.js';
import {
  VERSION, EDITABLE_KEYS, emptyBoard, normalize, validate, issueText, serialize,
  findCard, moveCard, addCard, setFields, today,
} from '../src/core/model.js';
import { boardText, boardMarkdown, columnLabel } from '../src/core/text.js';
import { diffBoards, diffText } from '../src/core/diff.js';

const HELP = `IluBoard ${APP_VERSION} — kanban board in one JSON file (board format v${VERSION})

Usage: node iluboard.mjs <command> <board.json> [options]

Read
  text <file> [--full] [--columns todo,doing]   the board as text, one line per card
  md <file> [--out backlog.md] [--columns ...]   Markdown tables (for backlog.md)
  validate <file> [--json]                       schema, unique ids, columns, done_when; exit 1 on errors
  diff <file> --git [rev]                        what changed since the last commit (default HEAD)
  diff <old.json> <new.json>                     what changed between two files
       [--json]

Write (re-read → change → validate → write canonical file; nothing is written when invalid)
  fmt <file> [--check]                           canonical format (key order, cards by column and order)
  move <file> <id> <column> [--top | --index N] [--done-when "…"]
  add <file> --title "…" [--id B9] [--column todo] [--priority P1] [--size M]
       [--owner max] [--goal 3b] [--done-when "…"] [--notes "…"] [--tags a,b]
       [--due 2026-10-12] [--top]
  set <file> <id> [--title "…"] [--priority P0] …  change fields ("" removes a field)
  init <file> [--title "Project"] [--prefix B]   create an empty board (refuses to overwrite)

Options
  --lang ru|en      language of text / md / diff / messages (default ru, or ILUBOARD_LANG)
  --by agent|human  who is recorded in updated_by (default agent)
  --version, --help

Columns: idea, todo, doing, done, dropped (from the file). todo and doing need done_when.
Docs: https://ilumetric.github.io/IluBoard/docs/AGENT.md
`;

const BOOL = new Set(['full', 'check', 'json', 'top', 'help', 'version', 'h', 'v', 'force']);

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || /^-[a-z]$/.test(a)) {
      let key = a.replace(/^--?/, '');
      let val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      key = key.replace(/-/g, '_');
      if (val === undefined) {
        if (BOOL.has(key)) val = true;
        else if (key === 'git') val = argv[i + 1] && !argv[i + 1].startsWith('-') && !/\.json$/i.test(argv[i + 1]) ? argv[++i] : 'HEAD';
        else if (i + 1 < argv.length) val = argv[++i];
        else throw new UsageError(`option --${key} needs a value`);
      }
      opt[key] = val;
    } else pos.push(a);
  }
  return { pos, opt };
}

class UsageError extends Error {}

const out = (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
const err = (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`);

function readBoard(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    throw new UsageError(e.code === 'ENOENT' ? `${file}: no such file` : `${file}: ${e.message}`);
  }
  try { return { text, doc: normalize(text) }; } catch (e) { throw new UsageError(`${file}: ${e.message}`); }
}

/** Validate and write atomically; returns false (and prints why) when invalid. */
function writeBoard(file, doc, lang, { touchMeta = true } = {}) {
  if (touchMeta && doc.meta && typeof doc.meta === 'object') doc.meta.updated = today();
  const v = validate(doc);
  if (!v.ok) {
    err(`${file}: not written — the board would be invalid:`);
    for (const e of v.errors) err(`  error: ${issueText(e, lang)}`);
    return false;
  }
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, serialize(doc), 'utf8');
  renameSync(tmp, file);
  return true;
}

/** Card fields from options (--done-when → done_when). */
function fieldsFrom(opt) {
  const f = {};
  for (const k of EDITABLE_KEYS) if (opt[k] !== undefined && opt[k] !== true) f[k] = String(opt[k]);
  for (const k of Object.keys(opt)) if (k.startsWith('x_')) f[k] = opt[k];
  return f;
}

function gitVersion(file, rev) {
  const dir = dirname(resolve(file));
  try {
    execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    throw new UsageError(`${file}: not inside a git repository`);
  }
  try {
    return execFileSync('git', ['-C', dir, 'show', `${rev}:./${basename(file)}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null; // not in that revision (new file)
  }
}

const COMMANDS = {
  text({ pos, opt, lang }) {
    const { doc } = readBoard(need(pos[0], 'file'));
    out(boardText(doc, { lang, full: !!opt.full, columns: list(opt.columns) }));
  },

  md({ pos, opt, lang }) {
    const file = need(pos[0], 'file');
    const { doc } = readBoard(file);
    const text = boardMarkdown(doc, { lang, columns: list(opt.columns), source: basename(file) });
    if (opt.out) { writeFileSync(opt.out, text, 'utf8'); out(`wrote ${opt.out}`); } else out(text);
  },

  validate({ pos, opt, lang }) {
    const file = need(pos[0], 'file');
    const { doc } = readBoard(file);
    const v = validate(doc);
    if (opt.json) {
      out(JSON.stringify({ ok: v.ok, errors: v.errors.map((e) => ({ ...e, message: issueText(e, lang) })), warnings: v.warnings.map((e) => ({ ...e, message: issueText(e, lang) })) }, null, 2));
      return v.ok ? 0 : 1;
    }
    for (const e of v.errors) out(`error: ${issueText(e, lang)}  [${e.path}]`);
    for (const w of v.warnings) out(`warning: ${issueText(w, lang)}  [${w.path}]`);
    out(v.ok ? `${file}: ok (${doc.cards.length} cards${v.warnings.length ? `, ${v.warnings.length} warnings` : ''})` : `${file}: ${v.errors.length} error(s)`);
    return v.ok ? 0 : 1;
  },

  fmt({ pos, opt }) {
    const file = need(pos[0], 'file');
    const { text, doc } = readBoard(file);
    const canon = serialize(doc);
    if (opt.check) {
      out(canon === text ? `${file}: canonical` : `${file}: not canonical (run: node iluboard.mjs fmt ${file})`);
      return canon === text ? 0 : 1;
    }
    if (canon === text) { out(`${file}: already canonical`); return 0; }
    writeFileSync(file, canon, 'utf8');
    out(`${file}: formatted`);
    return 0;
  },

  diff({ pos, opt, lang }) {
    let a;
    let b;
    let note = '';
    if (opt.git) {
      const file = need(pos[0], 'file');
      b = readBoard(file).doc;
      const old = gitVersion(file, opt.git);
      if (old === null) { a = emptyBoard(); a.columns = b.columns; note = `${file} is not in ${opt.git}: every card is new.\n\n`; } else a = normalize(old);
    } else {
      if (pos.length < 2) throw new UsageError('diff needs two files, or one file and --git [rev]');
      a = readBoard(pos[0]).doc;
      b = readBoard(pos[1]).doc;
    }
    const d = diffBoards(a, b);
    if (opt.json) out(JSON.stringify(d, null, 2));
    else out(note + diffText(d, { lang }));
    return 0;
  },

  move({ pos, opt, lang, by }) {
    const file = need(pos[0], 'file');
    const id = need(pos[1], 'card id');
    const column = need(pos[2], 'column');
    const { doc } = readBoard(file);
    if (!findCard(doc, id)) throw new UsageError(`no card "${id}"`);
    if (!doc.columns.includes(column)) throw new UsageError(`no column "${column}" (columns: ${doc.columns.join(', ')})`);
    if (opt.done_when !== undefined) setFields(doc, id, { done_when: String(opt.done_when) }, { by });
    const index = opt.top ? 0 : opt.index !== undefined ? Number(opt.index) : undefined;
    const card = moveCard(doc, id, column, index, { by });
    if (!writeBoard(file, doc, lang)) return 1;
    out(`${card.id} → ${column} (${columnLabel(column, lang)}), position ${card.order}`);
    return 0;
  },

  add({ pos, opt, lang, by }) {
    const file = need(pos[0], 'file');
    const { doc } = readBoard(file);
    const fields = fieldsFrom(opt);
    if (!fields.title) throw new UsageError('add needs --title');
    let card;
    try {
      card = addCard(doc, { ...fields, id: opt.id, column: opt.column }, { by, index: opt.top ? 0 : undefined });
    } catch (e) { throw new UsageError(e.message); }
    if (!writeBoard(file, doc, lang)) return 1;
    out(`added ${card.id} → ${card.column} (${columnLabel(card.column, lang)})`);
    return 0;
  },

  set({ pos, opt, lang, by }) {
    const file = need(pos[0], 'file');
    const id = need(pos[1], 'card id');
    const { doc } = readBoard(file);
    if (!findCard(doc, id)) throw new UsageError(`no card "${id}"`);
    const fields = fieldsFrom(opt);
    if (!Object.keys(fields).length) throw new UsageError(`set needs at least one field (${EDITABLE_KEYS.map((k) => `--${k.replace(/_/g, '-')}`).join(' ')})`);
    const changed = setFields(doc, id, fields, { by });
    if (!changed.length) { out(`${id}: nothing changed`); return 0; }
    if (!writeBoard(file, doc, lang)) return 1;
    out(`${id}: ${changed.join(', ')}`);
    return 0;
  },

  init({ pos, opt }) {
    const file = need(pos[0], 'file');
    let exists = true;
    try { readFileSync(file); } catch { exists = false; }
    if (exists && !opt.force) throw new UsageError(`${file} already exists (use --force to overwrite)`);
    const doc = emptyBoard(opt.title ? String(opt.title) : 'Board');
    if (opt.prefix) doc.meta.id_prefix = String(opt.prefix);
    writeFileSync(file, serialize(doc), 'utf8');
    out(`created ${file}`);
    return 0;
  },
};

function need(v, what) {
  if (v === undefined) throw new UsageError(`missing ${what}`);
  return v;
}

const list = (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined);

function main(argv) {
  let args;
  try { args = parseArgs(argv); } catch (e) { err(`iluboard: ${e.message}`); return 2; }
  const { pos, opt } = args;
  if (opt.version || opt.v || pos[0] === 'version') { out(`iluboard ${APP_VERSION} (board format v${VERSION})`); return 0; }
  const cmd = pos.shift();
  if (!cmd || opt.help || opt.h || cmd === 'help') { out(HELP); return cmd || opt.help || opt.h ? 0 : 2; }
  const run = COMMANDS[cmd];
  if (!run) { err(`iluboard: unknown command "${cmd}" (see --help)`); return 2; }
  const lang = String(opt.lang || process.env.ILUBOARD_LANG || 'ru') === 'en' ? 'en' : 'ru';
  const by = opt.by === 'human' ? 'human' : 'agent';
  try {
    return run({ pos, opt, lang, by }) ?? 0;
  } catch (e) {
    if (e instanceof UsageError || e instanceof SyntaxError) { err(`iluboard: ${e.message}`); return 2; }
    throw e;
  }
}

process.exitCode = main(process.argv.slice(2));
