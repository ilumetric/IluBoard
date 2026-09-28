// Small DOM helpers: element builder, modal dialogs, popover menus, toasts.

import { iconSvg } from './icons.js';
import { t } from './i18n.js';

/** h('button.btn.primary', { onclick, title }, 'text', childNode…) */
export function h(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'class') node.className += ` ${v}`;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, x] of Object.entries(v)) {
        if (p.startsWith('--')) node.style.setProperty(p, String(x)); else node.style[p] = x;
      }
    }
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const icon = (name, size) => {
  const s = document.createElement('span');
  s.className = 'ico';
  s.innerHTML = iconSvg(name, size);
  return s;
};

/** An icon button with a tooltip. */
export const iconBtn = (name, title, onclick, cls = '') => h(`button.icon-btn${cls ? `.${cls}` : ''}`, { type: 'button', title, 'aria-label': title, onclick }, icon(name));

// ---- dialogs ---------------------------------------------------------------------

/**
 * Open a modal. `body` is a node; `actions` [{ label, kind: 'primary'|'danger'|'ghost', onClick, autofocus }]
 * (onClick returning false keeps the dialog open). Returns { close, node }.
 * `onClose(reason)` runs once; reason is 'action' or 'dismiss' (Esc, ×, backdrop).
 */
export function openDialog({ title, body, actions = [], wide = false, onClose, className = '' }) {
  const dlg = h(`dialog.dialog${wide ? '.wide' : ''}${className ? `.${className}` : ''}`);
  let closed = false;
  const close = (reason = 'action') => {
    if (closed) return;
    closed = true;
    dlg.close();
    dlg.remove();
    onClose?.(reason);
  };
  const head = h('div.dlg-head', {}, h('h2', {}, title), iconBtn('x', t('dlg.close'), () => close('dismiss')));
  const foot = actions.length
    ? h('div.dlg-foot', {}, ...actions.map((a) => {
      if (a.spacer) return h('div.grow');
      if (a.kind === 'meta') return h('span.dlg-meta', {}, a.label);
      const b = h(`button.btn${a.kind ? `.${a.kind}` : ''}`, { type: 'button', autofocus: a.autofocus }, a.label);
      b.addEventListener('click', async () => {
        const keep = await a.onClick?.();
        if (keep !== false) close('action');
      });
      return b;
    }))
    : null;
  dlg.append(head, h('div.dlg-body', {}, body), foot);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close('dismiss'); });
  dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.dataset.down = '1'; });
  dlg.addEventListener('click', (e) => { if (e.target === dlg && dlg.dataset.down) close('dismiss'); delete dlg.dataset.down; });
  document.body.append(dlg);
  dlg.showModal();
  return { close, node: dlg };
}

/** Promise<boolean> confirm dialog. */
export function confirmDialog({ title, text, ok, danger = false, cancel = t('dlg.cancel') }) {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      title,
      body: h('p.dlg-text', {}, text),
      actions: [
        { spacer: true },
        { label: cancel, kind: 'ghost', onClick: () => { result = false; } },
        { label: ok, kind: danger ? 'danger' : 'primary', autofocus: true, onClick: () => { result = true; } },
      ],
      onClose: () => resolve(result),
    });
  });
}

// ---- menus -----------------------------------------------------------------------

let openMenuNode = null;

export function closeMenu() {
  openMenuNode?.remove();
  openMenuNode = null;
}

/**
 * Popover menu under `anchor`. items: [{ label, icon, onClick, checked, danger, hint } | { sep: true } | { title }]
 */
export function openMenu(anchor, items, { align = 'left', up = false } = {}) {
  closeMenu();
  const menu = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (it.sep) { menu.append(h('div.menu-sep')); continue; }
    if (it.title) { menu.append(h('div.menu-title', {}, it.title)); continue; }
    const b = h(`button.menu-item${it.danger ? '.danger' : ''}`, { type: 'button', role: 'menuitem' },
      it.icon ? icon(it.icon, 16) : h('span.ico-space'),
      h('span.grow', {}, it.label),
      it.hint ? h('span.menu-hint', {}, it.hint) : null,
      it.checked ? icon('check', 16) : null);
    b.addEventListener('click', () => { closeMenu(); it.onClick?.(); });
    menu.append(b);
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = align === 'right' ? r.right - mw : r.left;
  x = Math.max(8, Math.min(x, innerWidth - mw - 8));
  let y = up ? r.top - mh - 6 : r.bottom + 6;
  if (y + mh > innerHeight - 8) y = Math.max(8, r.top - mh - 6);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  openMenuNode = menu;
  menu.querySelector('button')?.focus({ preventScroll: true });
  setTimeout(() => {
    const off = (e) => {
      if (!openMenuNode || openMenuNode.contains(e.target)) return;
      closeMenu();
      document.removeEventListener('pointerdown', off, true);
    };
    document.addEventListener('pointerdown', off, true);
  });
  menu.addEventListener('keydown', (e) => {
    const btns = [...menu.querySelectorAll('button')];
    const i = btns.indexOf(document.activeElement);
    if (e.key === 'Escape') { closeMenu(); anchor.focus?.(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length]?.focus(); }
  });
  return menu;
}

// ---- toasts ----------------------------------------------------------------------

/** Show a toast; `action` { label, onClick } adds a button. */
export function toast(text, { kind = 'info', action, timeout = 3500 } = {}) {
  const box = document.getElementById('toasts');
  const node = h(`div.toast.${kind}`, {}, h('span.toast-dot'), h('span.grow', {}, text));
  if (action) {
    node.append(h('button.toast-btn', { type: 'button', onclick: () => { action.onClick(); node.remove(); } }, action.label));
  }
  box.append(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 250);
  }, timeout);
}
