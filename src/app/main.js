// IluBoard web app: state, rendering, drag and drop, card dialog, open / save,
// watching the file on disk. The board lives only in board.json; the browser
// keeps nothing but UI preferences (theme, language, collapsed columns) and
// the list of recent file handles.

import {
  PRIORITIES, SIZES, NEEDS_DONE_WHEN, CLOSED_COLUMNS, ID_RE, emptyBoard, normalize, validate, issueText,
  serialize, findCard, cardsIn, moveCard, addCard, setFields, removeCard, nextId, idPrefix, today,
} from '../core/model.js';
import { diffBoards, diffSummary, diffText } from '../core/diff.js';
import { merge3 } from '../core/merge.js';
import { boardMarkdown } from '../core/text.js';
import { APP_VERSION } from '../core/version.js';
import { h, icon, iconBtn, openDialog, confirmDialog, openMenu, closeMenu, toast } from './ui.js';
import { t, getLang, setLang, colLabel } from './i18n.js';
import * as disk from './disk.js';

const $ = (id) => document.getElementById(id);
const CLI_URL = 'https://ilumetric.github.io/IluBoard/iluboard.mjs';
const REPO_URL = 'https://github.com/ilumetric/IluBoard';
const DEFAULT_OWNERS = ['max', 'producer', 'narrative', 'design', 'code'];

// ---- preferences (per browser, never board data) -------------------------------------

const pref = {
  get(k, d) { try { const v = localStorage.getItem(`iluboard.${k}`); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`iluboard.${k}`, JSON.stringify(v)); } catch { /* storage disabled */ } },
  raw(k, d) { try { return localStorage.getItem(`iluboard.${k}`) || d; } catch { return d; } },
  setRaw(k, v) { try { localStorage.setItem(`iluboard.${k}`, v); } catch { /* storage disabled */ } },
};

const mq = matchMedia('(prefers-color-scheme: light)');
function applyTheme() {
  const p = pref.raw('theme', 'system');
  const mode = p === 'system' ? (mq.matches ? 'light' : 'dark') : p;
  document.documentElement.dataset.theme = mode === 'light' ? 'light' : 'dark';
}
mq.addEventListener?.('change', applyTheme);

// ---- state ------------------------------------------------------------------------------

const S = {
  doc: null, // the board being edited
  source: null, // where it came from (disk.js)
  baseText: null, // the file text as last read or written
  baseCanon: null, // serialize() of that text — "clean" means serialize(doc) === baseCanon
  mtime: null,
  undo: [],
  redo: [],
  q: '',
  owners: new Set(),
  prios: new Set(),
  external: null, // { text } — the file changed on disk while there were unsaved edits
  server: null,
  recent: [],
  flash: new Set(), // card ids to highlight after a reload from disk
  composerCol: pref.get('composerCol', 'idea'),
  sidebar: pref.get('sidebar', innerWidth > 860),
  collapsed: new Set(pref.get('collapsed', [])),
  ui: {}, // persistent nodes
};

const isDirty = () => !!S.doc && serialize(S.doc) !== S.baseCanon;
const isNarrow = () => innerWidth <= 860;

function commit(fn) {
  const before = serialize(S.doc);
  const result = fn(S.doc);
  if (serialize(S.doc) === before) return result;
  S.undo.push(before);
  if (S.undo.length > 200) S.undo.shift();
  S.redo = [];
  render();
  return result;
}

function undo() {
  if (!S.undo.length) return;
  S.redo.push(serialize(S.doc));
  S.doc = normalize(S.undo.pop());
  render();
}

function redo() {
  if (!S.redo.length) return;
  S.undo.push(serialize(S.doc));
  S.doc = normalize(S.redo.pop());
  render();
}

// ---- opening ------------------------------------------------------------------------------

/** Load `text` from `source` as the current board. Returns false when it is not a board. */
function loadBoard(source, text, mtime = null) {
  let doc;
  try { doc = normalize(text); } catch (e) {
    toast(t('open.failed', { msg: e.message }), { kind: 'error', timeout: 7000 });
    return false;
  }
  if (doc.format !== 'iluboard') {
    toast(t('open.notBoard'), { kind: 'error', timeout: 6000 });
    return false;
  }
  S.doc = doc;
  S.source = source;
  S.baseText = text;
  S.baseCanon = serialize(doc);
  S.mtime = mtime;
  S.undo = [];
  S.redo = [];
  S.external = null;
  S.owners.clear();
  S.prios.clear();
  S.q = '';
  if (S.ui.search) S.ui.search.value = '';
  S.missing = false;
  if (!doc.columns.includes(S.composerCol)) S.composerCol = doc.columns[0];
  const v = validate(doc);
  if (!v.ok) toast(t('open.invalid', { n: v.errors.length }), { kind: 'warn', timeout: 6000, action: { label: t('errors.title'), onClick: showProblems } });
  disk.remember(source, doc.meta?.title || source.name).then(refreshRecent);
  if (isNarrow()) S.sidebar = false;
  render(true);
  return true;
}

async function confirmDiscard() {
  if (!isDirty()) return true;
  return confirmDialog({ title: t('discard.title'), text: t('discard.text'), ok: t('discard.ok'), danger: true });
}

async function openSource(source) {
  try {
    const { text, mtime } = await source.read();
    loadBoard(source, text, mtime);
  } catch (e) {
    toast(e.message === 'permission' ? t('open.permission') : t('open.failed', { msg: e.message }), { kind: 'error' });
  }
}

const aborted = (e) => e?.name === 'AbortError';

async function openFile() {
  if (!(await confirmDiscard())) return;
  if (S.server) return openServerPicker();
  try {
    if (disk.fsaSupported()) await openSource(await disk.pickFile());
    else {
      const src = await disk.pickFileFallback();
      loadBoard(src, (await src.read()).text);
    }
  } catch (e) { if (!aborted(e)) toast(t('open.failed', { msg: e.message }), { kind: 'error' }); }
}

async function openFolder() {
  if (!(await confirmDiscard())) return;
  if (S.server) return openServerPicker();
  if (!disk.fsaSupported()) return openFile();
  let dir;
  try { dir = await disk.pickFolder(); } catch (e) {
    if (!aborted(e)) toast(t('open.failed', { msg: e.message }), { kind: 'error' });
    return;
  }
  toast(t('pick.scanning'), { timeout: 1500 });
  let boards = [];
  try { boards = await disk.findBoards(dir); } catch (e) { toast(t('open.failed', { msg: e.message }), { kind: 'error' }); return; }
  if (boards.length === 1) return openSource(disk.fsaSource(boards[0].handle, boards[0].path));
  pickBoardDialog(boards.map((b) => ({ path: b.path, open: () => openSource(disk.fsaSource(b.handle, b.path)) })), async () => {
    const src = await disk.createInFolder(dir, serialize(emptyBoard(dir.name)));
    await openSource(src);
  });
}

async function openServerPicker() {
  let files = [];
  try { files = await disk.serverList(); } catch (e) { toast(t('open.failed', { msg: e.message }), { kind: 'error' }); return; }
  if (files.length === 1 && !S.doc) return openSource(disk.serverSource(files[0]));
  pickBoardDialog(files.map((p) => ({ path: p, open: () => openSource(disk.serverSource(p)) })), async () => {
    const src = disk.serverSource('board.json');
    await src.write(serialize(emptyBoard(S.server.folder)));
    await openSource(src);
  });
}

function pickBoardDialog(items, create) {
  const body = h('div.pick-list');
  let dlg;
  if (!items.length) body.append(h('p.dlg-text', {}, t('pick.none')));
  for (const it of items) {
    body.append(h('button.pick-row', { type: 'button', onclick: () => { dlg.close(); it.open(); } }, icon('file'), h('span.mono.grow', {}, it.path), icon('chevronRight', 16)));
  }
  dlg = openDialog({
    title: t('pick.title'),
    body,
    actions: [
      { label: t('pick.create'), kind: items.length ? 'ghost' : 'primary', onClick: () => create().catch((e) => toast(t('save.failed', { msg: e.message }), { kind: 'error' })) },
      { spacer: true },
      { label: t('dlg.cancel'), kind: 'ghost' },
    ],
  });
}

async function newBoard() {
  if (!(await confirmDiscard())) return;
  const doc = emptyBoard(t('top.untitled'));
  loadBoard(disk.memorySource('board.json'), serialize(doc));
}

async function openDemo() {
  if (!(await confirmDiscard())) return;
  try {
    const r = await fetch('examples/board.json', { cache: 'no-store' });
    const text = await r.text();
    loadBoard(disk.memorySource('board.json', text), text);
  } catch (e) { toast(t('open.failed', { msg: e.message }), { kind: 'error' }); }
}

async function closeBoard() {
  if (!(await confirmDiscard())) return;
  S.doc = null;
  S.source = null;
  S.external = null;
  render(true);
}

// ---- saving -------------------------------------------------------------------------------

async function save({ as = false } = {}) {
  if (!S.doc) return;
  const v = validate(S.doc);
  if (!v.ok && !(await confirmDialog({ title: t('top.save'), text: t('save.invalid', { n: v.errors.length }), ok: t('save.saveAnyway') }))) return;
  let src = S.source;
  const fresh = as || !src?.writable;
  if (fresh) {
    if (!disk.fsaSupported()) {
      stamp();
      const text = serialize(S.doc);
      disk.download(src?.name || 'board.json', text);
      S.baseText = text;
      S.baseCanon = text;
      toast(t('save.downloaded'));
      render();
      return;
    }
    try { src = await disk.pickSaveFile(src?.name || 'board.json'); } catch (e) {
      if (!aborted(e)) toast(t('save.failed', { msg: e.message }), { kind: 'error' });
      return;
    }
  } else {
    // never overwrite what someone else wrote since we read the file
    try {
      const disk0 = await src.read();
      if (disk0.text !== S.baseText) {
        S.external = { text: disk0.text };
        resolveExternal({ fromSave: true });
        render();
        return;
      }
    } catch { /* file gone: write it again */ }
  }
  stamp();
  const text = serialize(S.doc);
  try {
    const mtime = await src.write(text);
    S.source = src;
    S.baseText = text;
    S.baseCanon = text;
    S.mtime = mtime;
    S.external = null;
    S.missing = false;
    disk.remember(src, S.doc.meta?.title || src.name).then(refreshRecent);
    toast(t('save.ok'), { kind: 'ok', timeout: 1800 });
  } catch (e) {
    toast(e.message === 'permission' ? t('save.denied') : t('save.failed', { msg: e.message }), { kind: 'error', timeout: 6000 });
  }
  render();
}

/** meta.updated = today when the board differs from the file. */
function stamp() {
  if (serialize(S.doc) !== S.baseCanon && S.doc.meta && typeof S.doc.meta === 'object') S.doc.meta.updated = today();
}

function downloadJson() {
  disk.download(S.source?.name || 'board.json', serialize(S.doc));
}

function exportMarkdown() {
  disk.download('backlog.md', boardMarkdown(S.doc, { lang: getLang(), source: S.source?.name || 'board.json' }), 'text/markdown');
}

// ---- watching the file --------------------------------------------------------------------

let polling = false;
async function poll() {
  if (polling || !S.doc || !S.source || S.source.kind === 'memory' || document.hidden) return;
  polling = true;
  const src = S.source;
  try {
    const m = await src.stat();
    if (m !== null && m === S.mtime) return;
    const { text, mtime } = await src.read();
    if (src !== S.source) return;
    S.missing = false;
    if (text === S.baseText) { S.mtime = mtime; return; }
    if (S.external?.text === text) { S.mtime = mtime; return; }
    let theirs;
    try { theirs = normalize(text); } catch { return; } // half-written: look again next time
    S.mtime = mtime;
    onExternal(text, theirs);
  } catch {
    if (!S.missing) { S.missing = true; toast(t('ext.deleted'), { kind: 'warn' }); }
  } finally { polling = false; }
}

function onExternal(text, theirs) {
  if (!isDirty()) {
    const d = diffBoards(normalize(S.baseText), theirs);
    S.doc = theirs;
    S.baseText = text;
    S.baseCanon = serialize(theirs);
    S.undo = [];
    S.redo = [];
    S.external = null;
    S.flash = new Set([...d.moved.map((m) => m.id), ...d.added.map((c) => c.id), ...d.changed.map((c) => c.id)]);
    toast(t('ext.reloaded', { summary: diffSummary(d, getLang()) }), { timeout: 5000 });
    render();
    setTimeout(() => { S.flash.clear(); }, 2500);
    return;
  }
  S.external = { text };
  render();
}

function resolveExternal({ fromSave = false } = {}) {
  if (!S.external) return;
  const diskText = S.external.text;
  let theirs;
  try { theirs = normalize(diskText); } catch (e) { toast(e.message, { kind: 'error' }); return; }
  const base = normalize(S.baseText);
  const d = diffBoards(base, theirs);
  const choice = (ic, title, sub, onClick, cls = '') => h(`button.choice${cls ? `.${cls}` : ''}`, { type: 'button', onclick: () => { dlg.close(); onClick(); } },
    icon(ic), h('span.choice-text', {}, h('b', {}, title), h('span', {}, sub)));
  const body = h('div', {},
    h('p.dlg-text', {}, t('ext.body')),
    h('div.section-label', {}, t('ext.changes')),
    h('pre.diff', {}, diffText(d, { lang: getLang() }).trim()),
    h('div.choices', {},
      choice('merge', t('ext.merge'), t('ext.mergeSub'), () => doMerge(base, theirs, diskText, fromSave), 'recommended'),
      choice('refresh', t('ext.reload'), t('ext.reloadSub'), () => { loadBoard(S.source, diskText, S.mtime); }),
      choice('save', t('ext.overwrite'), t('ext.overwriteSub'), () => { S.baseText = diskText; S.external = null; save(); }),
    ));
  const dlg = openDialog({ title: t('ext.title'), body, wide: true, actions: [{ spacer: true }, { label: t('ext.later'), kind: 'ghost' }] });
}

function doMerge(base, theirs, diskText, thenSave) {
  const r = merge3(base, S.doc, theirs);
  S.undo.push(serialize(S.doc));
  S.redo = [];
  S.doc = normalize(r.doc);
  S.baseText = diskText;
  S.baseCanon = serialize(theirs);
  S.external = null;
  const n = r.conflicts.length + r.notes.length;
  toast(t('ext.merged', { n }), { kind: n ? 'warn' : 'ok', timeout: 5000 });
  render();
  if (thenSave && !n) save();
}

// ---- filters --------------------------------------------------------------------------------

function matches(c) {
  if (S.owners.size && !S.owners.has(c.owner || '')) return false;
  if (S.prios.size && !S.prios.has(c.priority || '')) return false;
  const q = S.q.trim().toLowerCase();
  if (!q) return true;
  const hay = [c.id, c.title, c.owner, c.goal, c.done_when, c.notes, c.due, ...(c.tags || []).map((x) => `#${x}`)].filter(Boolean).join(' \n ').toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

const filtering = () => !!(S.q.trim() || S.owners.size || S.prios.size);

function ownersOf(doc) {
  const m = new Map();
  for (const c of doc.cards) if (c?.owner) m.set(c.owner, (m.get(c.owner) || 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---- rendering --------------------------------------------------------------------------------

function render(structural = false) {
  closeMenu();
  $('app').classList.toggle('sidebar-closed', !S.sidebar);
  $('scrim').hidden = !(S.sidebar && isNarrow());
  document.title = S.doc ? `${isDirty() ? '• ' : ''}${S.doc.meta?.title || t('top.untitled')} — IluBoard` : 'IluBoard';
  renderSidebar();
  renderTopbar();
  renderBanner();
  if (!S.doc) renderEmpty();
  else renderBoard(structural);
  renderComposer();
}

function renderSidebar() {
  const side = $('sidebar');
  const item = (ic, label, onclick, { kbd, disabled, active, cls = '' } = {}) => h(`button.side-item${active ? '.active' : ''}${cls ? `.${cls}` : ''}`, { type: 'button', onclick, disabled },
    icon(ic), h('span.grow.ellipsis', {}, label), kbd ? h('kbd', {}, kbd) : null);
  const nav = h('nav.side-nav', {},
    item('edit', t('side.newCard'), () => newCardFromUi(), { kbd: 'N', disabled: !S.doc }),
    item('search', t('side.search'), () => focusSearch(), { kbd: 'Ctrl K', disabled: !S.doc }),
    S.server ? null : item('folder', t('side.openFolder'), openFolder),
    item('file', t('side.openFile'), openFile),
  );

  const scroll = h('div.side-scroll');
  if (S.doc) {
    const sec = h('div.side-section');
    sec.append(h('div.side-label', {}, t('side.columns')));
    for (const col of S.doc.columns) {
      const n = cardsIn(S.doc, col).length;
      sec.append(h('button.side-row', { type: 'button', onclick: () => scrollToColumn(col) },
        h(`span.col-dot.c-${col}`), h('span.grow.ellipsis', {}, colLabel(col)), h('span.side-count', {}, n)));
    }
    const owners = ownersOf(S.doc);
    if (owners.length) {
      sec.append(h('div.side-label', {}, t('side.owners')));
      for (const [o, n] of owners) {
        sec.append(h(`button.side-row${S.owners.has(o) ? '.active' : ''}`, { type: 'button', onclick: () => toggleSet(S.owners, o) },
          avatar(o), h('span.grow.ellipsis', {}, o), h('span.side-count', {}, n)));
      }
    }
    scroll.append(sec);
  }
  const rec = h('div.side-section');
  rec.append(h('div.side-label', {}, t('side.recent')));
  const recent = S.recent.filter((r) => r.kind === 'fsa' || (S.server && r.host === location.host));
  if (!recent.length) rec.append(h('div.side-hint', {}, t('side.recentEmpty')));
  for (const r of recent) {
    const active = S.source && S.source.kind === r.kind && S.source.path === r.path;
    const row = h(`div.side-row.recent${active ? '.active' : ''}`, { role: 'button', tabindex: 0, title: r.path },
      h('span.grow.ellipsis', {}, h('span', {}, r.title || r.path), h('span.recent-path', {}, r.path)),
      iconBtn('x', t('side.forget'), async (e) => { e.stopPropagation(); await disk.forget(r.key); refreshRecent(); }, 'tiny'));
    const go = async () => {
      if (active) return;
      if (!(await confirmDiscard())) return;
      try { await openSource(await disk.reopen(r)); } catch (e) { toast(e.message === 'permission' ? t('open.permission') : t('open.failed', { msg: e.message }), { kind: 'error' }); }
    };
    row.addEventListener('click', go);
    row.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    rec.append(row);
  }
  scroll.append(rec);

  const foot = h('div.side-foot', {},
    item('settings', t('side.settings'), openAppSettings),
    h('a.side-item', { href: 'docs/AGENT.md', target: '_blank', rel: 'noopener' }, icon('terminal'), h('span.grow', {}, t('side.agents'))),
  );

  side.replaceChildren(
    h('div.side-head', {},
      h('button.brand', { type: 'button', onclick: () => (S.doc ? scrollToColumn(S.doc.columns[0]) : null), title: `IluBoard ${APP_VERSION}` }, h('span.brand-logo', {}, icon('logo', 16)), h('span', {}, 'IluBoard')),
      iconBtn('sidebar', t('side.collapse'), () => setSidebar(false))),
    nav, scroll, foot);
}

function renderTopbar() {
  const bar = $('topbar');
  const left = h('div.top-left');
  if (!S.sidebar) left.append(iconBtn('sidebar', t('side.open'), () => setSidebar(true)));
  if (S.doc) {
    const titleBtn = h('button.board-title', { type: 'button', title: t('top.more') },
      h('span.ellipsis', {}, S.doc.meta?.title || t('top.untitled')), icon('chevronDown', 16));
    titleBtn.addEventListener('click', () => openMenu(titleBtn, [
      { label: t('menu.boardSettings'), icon: 'settings', onClick: openBoardSettings },
      { sep: true },
      { label: t('top.saveAs'), icon: 'save', onClick: () => save({ as: true }) },
      { label: t('menu.downloadJson'), icon: 'download', onClick: downloadJson },
      { label: t('menu.exportMd'), icon: 'book', onClick: exportMarkdown },
      S.source?.kind !== 'memory' ? { label: t('menu.reload'), icon: 'refresh', onClick: reloadFromDisk } : null,
      { sep: true },
      { label: t('menu.close'), icon: 'x', onClick: closeBoard },
    ].filter(Boolean)));
    left.append(titleBtn);
    const where = S.source?.path
      ? h('span.file-chip', { title: `${t('top.fileTitle')}: ${S.source.path}` }, icon('file', 14), h('span.ellipsis.mono', {}, S.source.path))
      : h('span.file-chip.muted-chip', {}, icon('file', 14), h('span.ellipsis', {}, t('top.noFile')));
    left.append(where);
    const dirty = isDirty();
    left.append(h(`span.save-state${dirty ? '.dirty' : ''}`, { title: dirty ? t('top.unsaved') : t('top.saved') }, h('span.dot'), h('span.state-text', {}, dirty ? t('top.unsaved') : t('top.saved'))));
  } else left.append(h('div.top-brand', {}, 'IluBoard'));

  const right = h('div.top-right');
  if (S.doc) {
    const v = validate(S.doc);
    if (!v.ok) right.append(h('button.pill-warn', { type: 'button', onclick: showProblems }, icon('alert', 16), t('top.errors', { n: v.errors.length })));
    right.append(
      h('button.icon-btn', { type: 'button', title: t('top.undo'), 'aria-label': t('top.undo'), disabled: !S.undo.length, onclick: undo }, icon('undo')),
      h('button.icon-btn', { type: 'button', title: t('top.redo'), 'aria-label': t('top.redo'), disabled: !S.redo.length, onclick: redo }, icon('redo')),
    );
    const writable = S.source?.writable;
    right.append(h('button.btn.primary.save-btn', { type: 'button', disabled: writable && !isDirty(), onclick: () => save(), title: 'Ctrl+S' },
      icon(writable ? 'save' : 'download', 16), h('span', {}, writable || disk.fsaSupported() ? (writable ? t('top.save') : t('top.saveAs')) : t('top.download'))));
  }
  bar.replaceChildren(left, right);
}

function renderBanner() {
  const b = $('banner');
  if (!S.external) { b.hidden = true; b.replaceChildren(); return; }
  b.hidden = false;
  b.replaceChildren(icon('alert', 16), h('span.grow', {}, t('ext.banner')),
    h('button.btn.small', { type: 'button', onclick: () => resolveExternal() }, t('ext.show')));
}

function renderEmpty() {
  S.ui.boardRoot = null;
  const c = $('content');
  const tile = (ic, title, sub, onclick) => h('button.tile', { type: 'button', onclick }, h('span.tile-ico', {}, icon(ic)), h('b', {}, title), h('span', {}, sub));
  const notes = [];
  if (S.server) notes.push(h('p.note', {}, icon('check', 14), t('empty.server', { folder: S.server.folder })));
  else if (!disk.fsaSupported()) notes.push(h('p.note.warn', {}, icon('alert', 14), t('empty.noFsa')));
  const cmd = `curl -O ${CLI_URL}`;
  c.replaceChildren(h('div.empty', {},
    h('div.empty-logo', {}, icon('logo', 28)),
    h('h1', {}, t('empty.title')),
    h('p.empty-sub', {}, t('empty.sub')),
    h('div.tiles', {},
      S.server ? tile('folder', t('empty.file'), S.server.folder, openServerPicker) : tile('folder', t('empty.folder'), t('empty.folderSub'), openFolder),
      S.server ? null : tile('file', t('empty.file'), t('empty.fileSub'), openFile),
      tile('plus', t('empty.new'), t('empty.newSub'), newBoard),
      tile('board', t('empty.demo'), t('empty.demoSub'), openDemo)),
    ...notes,
    h('button.agent-line', { type: 'button', title: 'Copy', onclick: () => { navigator.clipboard?.writeText(cmd); toast('Copied', { timeout: 1200 }); } },
      icon('terminal', 14), h('span.muted', {}, t('empty.agent')), h('code', {}, cmd)),
  ));
}

function renderBoard(structural) {
  const c = $('content');
  if (structural || !S.ui.boardRoot || !c.contains(S.ui.boardRoot)) {
    S.ui.search = h('input.search-input', { type: 'search', placeholder: t('filter.search'), value: S.q, 'aria-label': t('filter.search') });
    S.ui.search.addEventListener('input', () => { S.q = S.ui.search.value; renderColumns(); renderFilterChips(); });
    S.ui.search.addEventListener('keydown', (e) => { if (e.key === 'Escape') { S.ui.search.value = ''; S.q = ''; renderColumns(); renderFilterChips(); S.ui.search.blur(); } });
    S.ui.chips = h('div.filter-chips');
    S.ui.columns = h('div.board', { role: 'list' });
    S.ui.boardRoot = h('div.board-root', {},
      h('div.filters', {}, h('label.search', {}, icon('search', 16), S.ui.search), S.ui.chips),
      S.ui.columns);
    c.replaceChildren(S.ui.boardRoot);
  }
  renderFilterChips();
  renderColumns();
}

function renderFilterChips() {
  const box = S.ui.chips;
  if (!box) return;
  const ownerBtn = h(`button.chip${S.owners.size ? '.on' : ''}`, { type: 'button' }, icon('filter', 14),
    S.owners.size ? [...S.owners].join(', ') : `${t('filter.owner')}: ${t('filter.all').toLowerCase()}`, icon('chevronDown', 14));
  ownerBtn.addEventListener('click', () => {
    const owners = ownersOf(S.doc);
    openMenu(ownerBtn, [
      { title: t('filter.owner') },
      ...owners.map(([o, n]) => ({ label: `${o}`, hint: String(n), checked: S.owners.has(o), onClick: () => toggleSet(S.owners, o) })),
      { label: '—', hint: String(S.doc.cards.filter((x) => !x.owner).length), checked: S.owners.has(''), onClick: () => toggleSet(S.owners, '') },
      ...(S.owners.size ? [{ sep: true }, { label: t('filter.reset'), icon: 'x', onClick: () => { S.owners.clear(); render(); } }] : []),
    ]);
  });
  const prios = PRIORITIES.map((p) => h(`button.chip.prio-chip.p-${p.toLowerCase()}${S.prios.has(p) ? '.on' : ''}`, { type: 'button', onclick: () => toggleSet(S.prios, p), title: t('filter.priority') }, p));
  const total = S.doc.cards.length;
  const shown = S.doc.cards.filter(matches).length;
  box.replaceChildren(...[ownerBtn, h('div.chip-group', {}, ...prios),
    filtering() ? h('span.filter-count', {}, t('filter.shown', { shown, total })) : null,
    filtering() ? h('button.chip.ghost', { type: 'button', onclick: resetFilters }, icon('x', 14), t('filter.reset')) : null].filter(Boolean));
}

function resetFilters() {
  S.owners.clear();
  S.prios.clear();
  S.q = '';
  if (S.ui.search) S.ui.search.value = '';
  render();
}

function toggleSet(set, v) {
  if (set.has(v)) set.delete(v); else set.add(v);
  render();
}

function renderColumns() {
  const board = S.ui.columns;
  if (!board) return;
  const scrolls = {};
  for (const l of board.querySelectorAll('.col-list')) scrolls[l.dataset.col] = l.scrollTop;
  const focusedId = document.activeElement?.closest?.('.card')?.dataset.id;
  const v = validate(S.doc);
  const bad = new Set(v.errors.map((e) => e.id).filter(Boolean));
  const cols = S.doc.columns.map((col) => {
    const all = cardsIn(S.doc, col);
    const shown = all.filter(matches);
    const collapsed = S.collapsed.has(col);
    const head = h('div.col-head', {},
      h(`span.col-dot.c-${col}`),
      h('span.col-title', {}, colLabel(col)),
      h('span.col-count', {}, filtering() ? `${shown.length}/${all.length}` : all.length),
      h('span.grow'),
      iconBtn(collapsed ? 'expand' : 'collapse', collapsed ? t('col.expand') : t('col.collapse'), () => toggleCollapsed(col), 'tiny col-toggle'),
      collapsed ? null : iconBtn('plus', t('col.add'), () => newCardFromUi(col), 'tiny'));
    const list = h('div.col-list', { dataset: { col } });
    for (const card of shown) list.append(cardNode(card, bad.has(card.id)));
    if (!shown.length) list.append(h('div.col-empty', {}, filtering() && all.length ? t('col.hidden', { n: all.length }) : t('col.empty')));
    else if (filtering() && shown.length < all.length) list.append(h('div.col-hidden', {}, t('col.hidden', { n: all.length - shown.length })));
    const node = h(`section.col.c-${col}${collapsed ? '.collapsed' : ''}`, { dataset: { col }, role: 'listitem', 'aria-label': colLabel(col) }, head, list);
    if (collapsed) head.addEventListener('click', (e) => { if (!e.target.closest('button')) toggleCollapsed(col); });
    return node;
  });
  board.replaceChildren(...cols);
  for (const l of board.querySelectorAll('.col-list')) if (scrolls[l.dataset.col]) l.scrollTop = scrolls[l.dataset.col];
  if (focusedId) board.querySelector(`.card[data-id="${CSS.escape(focusedId)}"]`)?.focus({ preventScroll: true });
}

function toggleCollapsed(col) {
  if (S.collapsed.has(col)) S.collapsed.delete(col); else S.collapsed.add(col);
  pref.set('collapsed', [...S.collapsed]);
  renderColumns();
}

function scrollToColumn(col) {
  const node = S.ui.columns?.querySelector(`.col[data-col="${CSS.escape(col)}"]`);
  node?.scrollIntoView({ behavior: 'smooth', inline: 'start', block: 'nearest' });
  if (isNarrow()) setSidebar(false);
}

function hue(s) {
  let x = 2166136261;
  for (const ch of String(s)) x = Math.imul(x ^ ch.codePointAt(0), 16777619) >>> 0;
  return Math.round(((x % 1000) / 1000) * 360);
}

function avatar(name) {
  return h('span.avatar', { style: { '--h': hue(name) }, 'aria-hidden': 'true' }, String(name).charAt(0).toUpperCase());
}

function fmtDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const opts = { day: 'numeric', month: 'short' };
  if (y !== new Date().getFullYear()) opts.year = 'numeric';
  return new Intl.DateTimeFormat(getLang(), opts).format(dt).replace('.', '');
}

function daysUntil(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const now = new Date();
  return Math.round((new Date(y, m - 1, d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
}

function cardNode(c, invalid) {
  const closed = CLOSED_COLUMNS.includes(c.column);
  const cls = ['card', c.priority ? `p-${c.priority.toLowerCase()}` : '', closed ? 'closed' : '', c.column === 'dropped' ? 'dropped' : '', invalid ? 'invalid' : '', S.flash.has(c.id) ? 'flash' : ''].filter(Boolean).join('.');
  const top = h('div.card-top', {},
    h('span.card-id', {}, c.id),
    c.priority ? h(`span.badge.prio.p-${c.priority.toLowerCase()}`, {}, c.priority) : null,
    c.size ? h('span.badge.size', {}, c.size) : null,
    h('span.grow'),
    invalid ? h('span.card-flag.err', { title: t('card.invalid') }, icon('alert', 14)) : null,
    c.updated_by === 'agent' ? h('span.card-flag.agent', { title: t('card.agent', { date: c.updated || '' }) }, icon('sparkles', 14)) : null);
  const meta = [];
  if (c.owner) meta.push(h('span.meta-owner', {}, avatar(c.owner), h('span', {}, c.owner)));
  if (c.goal) meta.push(h('span.meta-chip', { title: t('dlg.goal') }, icon('flag', 12), c.goal));
  if (c.due) {
    const days = daysUntil(c.due);
    const state = closed ? '' : days < 0 ? '.overdue' : days <= 3 ? '.soon' : '';
    meta.push(h(`span.meta-chip.due${state}`, { title: `${t('dlg.due')}: ${c.due}${state === '.overdue' ? ` · ${t('card.overdue')}` : state === '.soon' ? ` · ${t('card.soon')}` : ''}` }, icon('calendar', 12), fmtDate(c.due)));
  }
  const node = h(`div.${cls}`, { tabindex: 0, role: 'button', dataset: { id: c.id }, 'aria-label': `${c.id} ${c.title || ''}` },
    top,
    h('div.card-title', {}, c.title || '—'),
    meta.length ? h('div.card-meta', {}, ...meta) : null,
    c.tags?.length ? h('div.card-tags', {}, ...c.tags.map((x) => h('span.tag', {}, `#${x}`))) : null);
  node.addEventListener('pointerdown', onCardPointerDown);
  node.addEventListener('click', () => { if (!suppressClick) openCardDialog(c.id); });
  node.addEventListener('keydown', onCardKey);
  return node;
}

// ---- composer (quick add, bottom) ----------------------------------------------------------

function renderComposer() {
  const wrap = $('composer-wrap');
  if (!S.doc) { wrap.hidden = true; return; }
  wrap.hidden = false;
  if (!S.ui.composer || !wrap.contains(S.ui.composer)) {
    const input = h('textarea.composer-input', { rows: 1, placeholder: t('composer.placeholder'), 'aria-label': t('composer.placeholder') });
    const send = h('button.send-btn', { type: 'button', title: t('composer.send'), 'aria-label': t('composer.send') }, icon('arrowUp', 18));
    const colBtn = h('button.composer-col', { type: 'button' });
    const autosize = () => { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 160)}px`; send.disabled = !input.value.trim(); };
    input.addEventListener('input', autosize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        quickAdd(input.value, e.shiftKey);
        input.value = '';
        autosize();
      }
    });
    send.addEventListener('click', () => { quickAdd(input.value, false); input.value = ''; autosize(); input.focus(); });
    colBtn.addEventListener('click', () => openMenu(colBtn, S.doc.columns.map((col) => ({
      label: colLabel(col), checked: col === S.composerCol, onClick: () => { S.composerCol = col; pref.set('composerCol', col); renderComposer(); },
    })), { up: true }));
    S.ui.composer = h('div.composer', {}, colBtn, input, send);
    S.ui.composerInput = input;
    S.ui.composerCol = colBtn;
    wrap.replaceChildren(S.ui.composer, h('div.composer-hint', {}, t('composer.hint')));
    autosize();
  }
  if (!S.doc.columns.includes(S.composerCol)) S.composerCol = S.doc.columns[0];
  S.ui.composerCol.replaceChildren(icon('plus', 16), h('span', {}, `${t('composer.to')} `), h(`span.col-dot.c-${S.composerCol}`), h('b', {}, colLabel(S.composerCol)), icon('chevronDown', 14));
}

function quickAdd(text, openAfter) {
  const title = text.trim().replace(/\s+/g, ' ');
  if (!title || !S.doc) return;
  const col = S.composerCol;
  if (NEEDS_DONE_WHEN.includes(col) || openAfter) {
    openCardDialog(null, { preset: { title, column: col } });
    return;
  }
  const card = commit((doc) => addCard(doc, { title, column: col }, { by: 'human' }));
  if (card) {
    S.flash = new Set([card.id]);
    renderColumns();
    setTimeout(() => S.flash.clear(), 1500);
    const node = S.ui.columns.querySelector(`.card[data-id="${CSS.escape(card.id)}"]`);
    node?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    toast(t('toast.created', { id: card.id }), { timeout: 1600 });
  }
}

function newCardFromUi(column) {
  if (!S.doc) return;
  openCardDialog(null, { preset: { column: column || S.composerCol } });
}

// ---- drag and drop -----------------------------------------------------------------------------

let drag = null;
let suppressClick = false;

function onCardPointerDown(e) {
  if (e.button !== 0 || drag) return;
  const card = e.currentTarget;
  const start = { x: e.clientX, y: e.clientY };
  const touch = e.pointerType === 'touch';
  let armed = !touch;
  let timer = touch ? setTimeout(() => { armed = true; card.classList.add('armed'); navigator.vibrate?.(10); }, 280) : null;
  const move = (ev) => {
    if (drag) { dragMove(ev); return; }
    const dist = Math.hypot(ev.clientX - start.x, ev.clientY - start.y);
    if (!armed) { if (dist > 8) cleanup(); return; }
    if (dist > (touch ? 2 : 5)) dragStart(card, ev, start);
  };
  const up = (ev) => {
    const was = drag;
    cleanup();
    if (was) {
      dragEnd(ev);
      suppressClick = true;
      setTimeout(() => { suppressClick = false; });
    }
  };
  const cancel = () => { const was = drag; cleanup(); if (was) dragCancel(); };
  function cleanup() {
    clearTimeout(timer);
    timer = null;
    card.classList.remove('armed');
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', cancel);
  }
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', cancel);
}

addEventListener('touchmove', (e) => { if (drag) e.preventDefault(); }, { passive: false });

function dragStart(card, ev, start) {
  const r = card.getBoundingClientRect();
  const ghost = card.cloneNode(true);
  ghost.classList.add('ghost');
  ghost.classList.remove('armed', 'flash');
  ghost.style.width = `${r.width}px`;
  document.body.append(ghost);
  const ph = h('div.placeholder', { style: { height: `${r.height}px` } });
  card.after(ph);
  card.classList.add('drag-src');
  drag = { id: card.dataset.id, card, ghost, ph, offX: start.x - r.left, offY: start.y - r.top, x: ev.clientX, y: ev.clientY, over: null, raf: 0 };
  document.body.classList.add('dragging');
  dragMove(ev);
  drag.raf = requestAnimationFrame(autoScroll);
}

function dragMove(ev) {
  const d = drag;
  d.x = ev.clientX;
  d.y = ev.clientY;
  d.ghost.style.transform = `translate(${d.x - d.offX}px, ${d.y - d.offY}px) rotate(2.5deg)`;
  const el = document.elementFromPoint(d.x, d.y);
  const colNode = el?.closest?.('.col');
  document.querySelectorAll('.col.drop-over').forEach((n) => { if (n !== colNode) n.classList.remove('drop-over'); });
  if (!colNode) return;
  colNode.classList.add('drop-over');
  if (colNode.classList.contains('collapsed')) { d.over = colNode.dataset.col; d.ph.remove(); return; }
  d.over = null;
  const list = colNode.querySelector('.col-list');
  const cards = [...list.querySelectorAll('.card:not(.drag-src)')];
  const before = cards.find((c) => { const r = c.getBoundingClientRect(); return d.y < r.top + r.height / 2; });
  if (before) { if (before.previousElementSibling !== d.ph) list.insertBefore(d.ph, before); } else {
    const last = cards[cards.length - 1];
    if (last) { if (last.nextElementSibling !== d.ph) last.after(d.ph); } else if (d.ph.parentElement !== list) list.prepend(d.ph);
  }
}

function autoScroll() {
  if (!drag) return;
  const board = S.ui.columns;
  const edge = 70;
  const b = board.getBoundingClientRect();
  if (drag.x < b.left + edge) board.scrollLeft -= Math.ceil((b.left + edge - drag.x) / 5);
  else if (drag.x > b.right - edge) board.scrollLeft += Math.ceil((drag.x - (b.right - edge)) / 5);
  const list = drag.ph.parentElement?.closest('.col-list');
  if (list) {
    const r = list.getBoundingClientRect();
    if (drag.y < r.top + 40) list.scrollTop -= Math.ceil((r.top + 40 - drag.y) / 4);
    else if (drag.y > r.bottom - 40) list.scrollTop += Math.ceil((drag.y - (r.bottom - 40)) / 4);
  }
  drag.raf = requestAnimationFrame(autoScroll);
}

function siblingCard(node, dir) {
  let n = node[dir];
  while (n && !(n.classList.contains('card') && !n.classList.contains('drag-src'))) n = n[dir];
  return n;
}

function dragEnd() {
  const d = drag;
  let column = null;
  let index;
  if (d.over) column = d.over;
  else if (d.ph.isConnected) {
    column = d.ph.closest('.col').dataset.col;
    const full = cardsIn(S.doc, column).filter((c) => c.id !== d.id);
    const next = siblingCard(d.ph, 'nextElementSibling');
    const prev = siblingCard(d.ph, 'previousElementSibling');
    if (next) index = full.findIndex((c) => c.id === next.dataset.id);
    else if (prev) index = full.findIndex((c) => c.id === prev.dataset.id) + 1;
    else index = full.length;
  }
  dragCancel();
  if (column) moveTo(d.id, column, index);
}

function dragCancel() {
  const d = drag;
  if (!d) return;
  cancelAnimationFrame(d.raf);
  d.ghost.remove();
  d.ph.remove();
  d.card.classList.remove('drag-src');
  document.querySelectorAll('.col.drop-over').forEach((n) => n.classList.remove('drop-over'));
  document.body.classList.remove('dragging');
  drag = null;
}

/** Move a card; when the new column needs done_when and the card has none, ask for it (Cancel undoes the move). */
function moveTo(id, column, index) {
  const card = findCard(S.doc, id);
  if (!card) return;
  const from = card.column;
  const depth = S.undo.length;
  commit((doc) => moveCard(doc, id, column, index, { by: 'human' }));
  if (from !== column && NEEDS_DONE_WHEN.includes(column) && !(card.done_when || '').trim()) {
    openCardDialog(id, { requireDoneWhen: true, onCancel: () => { if (S.undo.length > depth) undo(); } });
  }
}

function onCardKey(e) {
  const id = e.currentTarget.dataset.id;
  const card = findCard(S.doc, id);
  if (!card) return;
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCardDialog(id); return; }
  if (e.key === 'Delete') { e.preventDefault(); deleteCard(id); return; }
  if (!e.altKey) {
    // arrow keys walk between cards
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    e.preventDefault();
    const node = e.currentTarget;
    if (e.key === 'ArrowUp') siblingCard(node, 'previousElementSibling')?.focus();
    else if (e.key === 'ArrowDown') siblingCard(node, 'nextElementSibling')?.focus();
    else {
      let col = node.closest('.col');
      do col = e.key === 'ArrowLeft' ? col.previousElementSibling : col.nextElementSibling;
      while (col && (col.classList.contains('collapsed') || !col.querySelector('.card')));
      col?.querySelector('.card')?.focus();
    }
    return;
  }
  const cols = S.doc.columns;
  const ci = cols.indexOf(card.column);
  const list = cardsIn(S.doc, card.column);
  const i = list.indexOf(card);
  if (e.key === 'ArrowLeft' && ci > 0) { e.preventDefault(); moveTo(id, cols[ci - 1], 0); }
  else if (e.key === 'ArrowRight' && ci < cols.length - 1) { e.preventDefault(); moveTo(id, cols[ci + 1], 0); }
  else if (e.key === 'ArrowUp' && i > 0) { e.preventDefault(); moveTo(id, card.column, i - 1); }
  else if (e.key === 'ArrowDown' && i < list.length - 1) { e.preventDefault(); moveTo(id, card.column, i + 1); }
  else return;
  requestAnimationFrame(() => S.ui.columns.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.focus());
}

async function deleteCard(id) {
  if (!(await confirmDialog({ title: t('dlg.delete'), text: t('dlg.deleteConfirm', { id }), ok: t('dlg.delete'), danger: true }))) return false;
  commit((doc) => removeCard(doc, id));
  toast(t('toast.deleted', { id }), { action: { label: t('top.undo').replace(/\s*\(.*\)$/, ''), onClick: undo } });
  return true;
}

// ---- card dialog ---------------------------------------------------------------------------------

function segmented(values, current, onPick) {
  const box = h('div.seg', { role: 'radiogroup' });
  const all = ['', ...values];
  const paint = () => box.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === current));
  for (const v of all) {
    const b = h(`button.seg-btn${v ? `.v-${v.toLowerCase()}` : ''}`, { type: 'button', dataset: { v }, role: 'radio' }, v || t('dlg.none'));
    b.addEventListener('click', () => { current = v; onPick(v); paint(); });
    box.append(b);
  }
  paint();
  return box;
}

function field(label, control, { hint, error, wide } = {}) {
  const tag = /^(INPUT|TEXTAREA|SELECT)$/.test(control.tagName) ? 'label' : 'div';
  return h(`${tag}.field${wide ? '.wide' : ''}`, {}, h('span.field-label', {}, label, hint ? h('span.field-hint', {}, hint) : null), control, error || null);
}

function openCardDialog(id, { preset = {}, requireDoneWhen = false, onCancel } = {}) {
  const isNew = !id;
  const card = isNew ? null : findCard(S.doc, id);
  if (!isNew && !card) return;
  const f = isNew
    ? { id: nextId(S.doc), title: '', column: S.doc.columns[0], priority: '', size: '', owner: '', goal: '', due: '', done_when: '', notes: '', tags: '', ...preset }
    : { ...card, tags: (card.tags || []).join(', '), priority: card.priority || '', size: card.size || '' };

  const errs = {};
  const errNode = (k) => { errs[k] = h('span.field-error'); return errs[k]; };
  const input = (k, attrs = {}) => {
    const el = h('input.input', { type: 'text', value: f[k] ?? '', ...attrs });
    el.addEventListener('input', () => { f[k] = el.value; clearErr(k); });
    return el;
  };
  const area = (k, attrs = {}) => {
    const el = h('textarea.input', { rows: 2, ...attrs });
    el.value = f[k] ?? '';
    const size = () => { el.style.height = 'auto'; el.style.height = `${Math.min(el.scrollHeight + 2, 320)}px`; };
    el.addEventListener('input', () => { f[k] = el.value; clearErr(k); size(); });
    requestAnimationFrame(size);
    return el;
  };
  const clearErr = (k) => { if (errs[k]) errs[k].textContent = ''; };

  const owners = [...new Set([...ownersOf(S.doc).map(([o]) => o), ...DEFAULT_OWNERS])];
  const goals = [...new Set(S.doc.cards.map((c) => c.goal).filter(Boolean))].sort();
  const dlOwners = h('datalist', { id: 'dl-owners' }, ...owners.map((o) => h('option', { value: o })));
  const dlGoals = h('datalist', { id: 'dl-goals' }, ...goals.map((o) => h('option', { value: o })));

  const titleEl = area('title', { rows: 1, placeholder: t('dlg.titlePh'), class: 'title-input' });
  const colSel = h('select.input', {}, ...S.doc.columns.map((c) => h('option', { value: c, selected: c === f.column }, colLabel(c))));
  const doneReq = h('span.req', {}, '*');
  const paintReq = () => { doneReq.hidden = !NEEDS_DONE_WHEN.includes(f.column); };
  colSel.addEventListener('change', () => { f.column = colSel.value; paintReq(); });
  paintReq();
  const doneEl = area('done_when', { placeholder: t('dlg.doneWhenPh') });
  const dueEl = input('due', { type: 'date' });

  const idEl = isNew ? input('id', { class: 'mono', spellcheck: false }) : null;
  const extra = Object.keys(card || {}).filter((k) => k.startsWith('x_') || !['id', 'title', 'column', 'order', 'priority', 'size', 'owner', 'goal', 'done_when', 'notes', 'tags', 'due', 'updated', 'updated_by'].includes(k));

  const body = h('div.card-form', {},
    requireDoneWhen ? h('p.notice', {}, icon('alert', 16), t('dlg.needDoneWhen')) : null,
    field(t('dlg.title'), titleEl, { error: errNode('title'), wide: true }),
    h('div.grid2', {},
      isNew ? field(t('dlg.id'), idEl, { error: errNode('id') }) : null,
      field(t('dlg.column'), colSel),
      field(t('dlg.owner'), input('owner', { list: 'dl-owners', autocomplete: 'off' })),
      field(t('dlg.goal'), input('goal', { list: 'dl-goals', placeholder: t('dlg.goalPh'), autocomplete: 'off' })),
      field(t('dlg.due'), dueEl)),
    h('div.grid2', {},
      field(t('dlg.priority'), segmented(PRIORITIES, f.priority, (v) => { f.priority = v; })),
      field(t('dlg.size'), segmented(SIZES, f.size, (v) => { f.size = v; }))),
    h('label.field.wide', {}, h('span.field-label', {}, t('dlg.doneWhen'), doneReq, h('span.field-hint', {}, t('dlg.doneWhenReq'))), doneEl, errNode('done_when')),
    field(t('dlg.notes'), area('notes', { rows: 3 }), { wide: true }),
    field(t('dlg.tags'), input('tags', { placeholder: t('dlg.tagsPh') }), { wide: true }),
    extra.length ? h('details.extra', {}, h('summary', {}, t('dlg.extra')),
      h('pre.diff', {}, extra.map((k) => `${k}: ${JSON.stringify(card[k])}`).join('\n'))) : null,
    dlOwners, dlGoals);

  const submit = () => {
    let ok = true;
    const setErr = (k, msg) => { if (errs[k]) errs[k].textContent = msg; ok = false; };
    if (!String(f.title).trim()) setErr('title', t('dlg.errTitle'));
    if (NEEDS_DONE_WHEN.includes(f.column) && !String(f.done_when || '').trim()) setErr('done_when', t('dlg.errDoneWhen'));
    if (isNew) {
      const nid = String(f.id).trim();
      if (!ID_RE.test(nid)) setErr('id', t('dlg.errId'));
      else if (findCard(S.doc, nid)) setErr('id', t('dlg.errIdUsed'));
    }
    if (!ok) { body.querySelector('.field-error:not(:empty)')?.closest('.field')?.querySelector('input,textarea')?.focus(); return false; }
    const fields = { title: f.title, priority: f.priority, size: f.size, owner: f.owner, goal: f.goal, due: f.due, done_when: f.done_when, notes: f.notes, tags: f.tags };
    if (isNew) {
      const created = commit((doc) => addCard(doc, { ...fields, id: String(f.id).trim(), column: f.column }, { by: 'human' }));
      if (created) toast(t('toast.created', { id: created.id }), { timeout: 1600 });
    } else {
      commit((doc) => {
        setFields(doc, id, fields, { by: 'human' });
        if (f.column !== card.column) moveCard(doc, id, f.column, 0, { by: 'human' });
      });
    }
    saved = true;
    return true;
  };

  let saved = false;
  const actions = [];
  if (!isNew && !requireDoneWhen) {
    actions.push({ label: t('dlg.delete'), kind: 'danger-ghost', onClick: async () => { dlg.close('action'); await deleteCard(id); } });
  }
  actions.push({ spacer: true });
  if (!isNew && card.updated) actions.push({ label: t('dlg.updated', { date: card.updated, by: card.updated_by ? t(`by.${card.updated_by}`) : '' }), kind: 'meta' });
  actions.push({ label: t('dlg.cancel'), kind: 'ghost' });
  actions.push({ label: isNew ? t('dlg.create') : t('dlg.save'), kind: 'primary', onClick: submit });

  const dlg = openDialog({
    title: isNew ? t('dlg.newCard') : h('span.dlg-title-card', {}, h('span.card-id', {}, card.id), card.priority ? h(`span.badge.prio.p-${card.priority.toLowerCase()}`, {}, card.priority) : null, t('dlg.editCard')),
    body,
    wide: true,
    className: 'card-dialog',
    actions,
    onClose: () => { if (!saved) onCancel?.(); },
  });
  dlg.node.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); if (submit() !== false) dlg.close('action'); }
  });
  requestAnimationFrame(() => {
    if (requireDoneWhen) doneEl.focus();
    else if (isNew || !f.title) titleEl.focus();
  });
}

// ---- other dialogs ---------------------------------------------------------------------------------

function openBoardSettings() {
  const f = { title: S.doc.meta?.title || '', prefix: S.doc.meta?.id_prefix || '' };
  const hint = h('span.field-note');
  const paint = () => { hint.textContent = t('settings.prefixHint', { id: nextId(S.doc, f.prefix.trim() || idPrefix({ ...S.doc, meta: { ...S.doc.meta, id_prefix: '' } })) }); };
  const title = h('input.input', { type: 'text', value: f.title });
  title.addEventListener('input', () => { f.title = title.value; });
  const prefix = h('input.input.mono', { type: 'text', value: f.prefix, placeholder: idPrefix(S.doc), spellcheck: false });
  prefix.addEventListener('input', () => { f.prefix = prefix.value; paint(); });
  paint();
  openDialog({
    title: t('settings.title'),
    body: h('div.card-form', {}, field(t('settings.boardTitle'), title, { wide: true }), field(t('settings.prefix'), prefix, { wide: true }), hint),
    actions: [{ spacer: true }, { label: t('dlg.cancel'), kind: 'ghost' }, {
      label: t('dlg.save'), kind: 'primary', onClick: () => {
        const p = f.prefix.trim();
        if (p && !/^[A-Za-z0-9_.-]+$/.test(p)) { prefix.focus(); return false; }
        commit((doc) => {
          if (!doc.meta || typeof doc.meta !== 'object') doc.meta = {};
          if (f.title.trim()) doc.meta.title = f.title.trim(); else delete doc.meta.title;
          if (p) doc.meta.id_prefix = p; else delete doc.meta.id_prefix;
        });
        return true;
      },
    }],
  });
  requestAnimationFrame(() => title.focus());
}

function openAppSettings() {
  const theme = pref.raw('theme', 'system');
  const seg = (items, current, onPick) => {
    const box = h('div.seg');
    for (const [v, label, ic] of items) {
      const b = h(`button.seg-btn${v === current ? '.on' : ''}`, { type: 'button' }, ic ? icon(ic, 15) : null, label);
      b.addEventListener('click', () => { box.querySelectorAll('.seg-btn').forEach((x) => x.classList.remove('on')); b.classList.add('on'); onPick(v); });
      box.append(b);
    }
    return box;
  };
  const body = h('div.card-form', {},
    field(t('settings.theme'), seg([['system', t('theme.system'), 'monitor'], ['dark', t('theme.dark'), 'moon'], ['light', t('theme.light'), 'sun']], theme, (v) => { pref.setRaw('theme', v); applyTheme(); }), { wide: true }),
    field(t('settings.language'), seg([['ru', 'Русский'], ['en', 'English']], getLang(), (v) => { pref.setRaw('lang', v); setLang(v); dlg.close(); S.ui = {}; render(true); openAppSettings(); }), { wide: true }),
    h('div.about', {},
      h('span', {}, `IluBoard ${APP_VERSION}`),
      h('a', { href: REPO_URL, target: '_blank', rel: 'noopener' }, icon('github', 14), 'GitHub'),
      h('a', { href: 'docs/AGENT.md', target: '_blank', rel: 'noopener' }, icon('terminal', 14), 'AGENT.md'),
      h('a', { href: 'docs/FORMAT.md', target: '_blank', rel: 'noopener' }, icon('book', 14), 'FORMAT.md')));
  const dlg = openDialog({ title: t('settings.appTitle'), body, actions: [{ spacer: true }, { label: t('dlg.ok'), kind: 'primary' }] });
}

function showProblems() {
  const v = validate(S.doc);
  const lang = getLang();
  const row = (issue, kind) => {
    const b = h(`button.problem.${kind}`, { type: 'button' }, icon(kind === 'err' ? 'alert' : 'filter', 15), h('span.grow', {}, issueText(issue, lang)), h('span.mono.muted.small', {}, issue.path));
    b.addEventListener('click', () => { if (issue.id && findCard(S.doc, issue.id)) { dlg.close(); openCardDialog(issue.id); } });
    return b;
  };
  const body = h('div.problems', {},
    ...v.errors.map((e) => row(e, 'err')),
    v.warnings.length ? h('div.section-label', {}, t('errors.warnings')) : null,
    ...v.warnings.map((w) => row(w, 'warn')));
  const dlg = openDialog({ title: t('errors.title'), body, wide: true, actions: [{ spacer: true }, { label: t('dlg.ok'), kind: 'primary' }] });
}

async function reloadFromDisk() {
  if (!(await confirmDiscard())) return;
  await openSource(S.source);
}

// ---- layout helpers --------------------------------------------------------------------------------

function setSidebar(open) {
  S.sidebar = open;
  if (!isNarrow()) pref.set('sidebar', open);
  render();
}

function focusSearch() {
  if (!S.doc) return;
  if (isNarrow()) setSidebar(false);
  S.ui.search?.focus();
  S.ui.search?.select();
}

async function refreshRecent() {
  S.recent = await disk.recentList();
  renderSidebar();
}

// ---- keyboard ------------------------------------------------------------------------------------

const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  const inDialog = !!document.querySelector('dialog[open]');
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (!inDialog) save({ as: e.shiftKey }); return; }
  if (inDialog) return;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); focusSearch(); return; }
  if (mod && e.key.toLowerCase() === 'b') { e.preventDefault(); setSidebar(!S.sidebar); return; }
  if (typing(e.target)) return;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
  if (!mod && !e.altKey && e.key.toLowerCase() === 'n' && S.doc) { e.preventDefault(); newCardFromUi(); return; }
  if (!mod && e.key === '/' && S.doc) { e.preventDefault(); focusSearch(); }
  if (e.key === 'Escape' && drag) dragCancel();
});

addEventListener('beforeunload', (e) => {
  if (isDirty()) { e.preventDefault(); e.returnValue = t('unload'); }
});

addEventListener('resize', () => {
  const narrow = isNarrow();
  if (narrow !== S.wasNarrow) { S.wasNarrow = narrow; if (narrow) S.sidebar = false; else S.sidebar = pref.get('sidebar', true); render(); }
});

// ---- start ---------------------------------------------------------------------------------------

async function start() {
  applyTheme();
  S.wasNarrow = isNarrow();
  if (S.wasNarrow) S.sidebar = false;
  $('scrim').addEventListener('click', () => setSidebar(false));
  render(true);
  S.server = await disk.detectServer();
  S.recent = await disk.recentList();
  render(true);
  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  if (S.server && file) await openSource(disk.serverSource(file));
  else if (params.has('demo')) await openDemo();
  setInterval(poll, 2000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  addEventListener('focus', () => poll());
}

start();
