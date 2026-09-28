#!/usr/bin/env node
// Bundle the CLI (tools/iluboard.mjs + the src/ modules it imports) into one
// self-contained file, `iluboard.mjs` at the repo root, so an agent can fetch a
// single URL and run it with plain Node. No dependencies.
//
//   node tools/bundle.mjs            write iluboard.mjs
//   node tools/bundle.mjs --check    exit 1 if iluboard.mjs is out of date
//   node tools/bundle.mjs --stdout   print instead of writing
//
// How: walk the relative ESM import graph from the entry, wrap every module in
// its own function scope (so top-level names cannot collide) in dependency
// order, return its exports as an object and turn imports into destructuring
// from those objects. `node:` builtins are imported once, as namespaces, at the
// top. Import cycles are allowed: on the back edge the names are declared with
// `let` and bound right after the imported module has run (fine as long as they
// are only used at call time, which ESM requires anyway). Only the import/export forms the code base actually uses are supported;
// anything else (default / namespace imports of local modules, `export *`,
// `export default`, dynamic import(), import.meta, bare package imports) fails
// loudly instead of producing a bundle that behaves differently.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = 'tools/iluboard.mjs';
export const OUTPUT = 'iluboard.mjs';

const IDENT = '[A-Za-z_$][\\w$]*';
// Top-level statements start at column 0 in this code base (checked below).
const RE_IMPORT_NAMED = new RegExp(`^import\\s*\\{([^}]*)\\}\\s*from\\s*(['"])([^'"\\n]+)\\2[ \\t]*;?[ \\t]*$`, 'gm');
const RE_IMPORT_DEFAULT = new RegExp(`^import\\s+(${IDENT})\\s*(?:,\\s*\\{([^}]*)\\}\\s*)?from\\s*(['"])([^'"\\n]+)\\3[ \\t]*;?[ \\t]*$`, 'gm');
const RE_IMPORT_NS = new RegExp(`^import\\s*\\*\\s*as\\s+(${IDENT})\\s+from\\s*(['"])([^'"\\n]+)\\2[ \\t]*;?[ \\t]*$`, 'gm');
const RE_EXPORT_FROM = new RegExp(`^export\\s*\\{([^}]*)\\}\\s*from\\s*(['"])([^'"\\n]+)\\2[ \\t]*;?[ \\t]*$`, 'gm');
const RE_EXPORT_LIST = /^export\s*\{([^}]*)\}[ \t]*;?[ \t]*$/gm;
const RE_EXPORT_DECL = new RegExp(`^export\\s+((?:async\\s+)?function\\s*\\*?\\s*(${IDENT})|class\\s+(${IDENT})|(const|let|var)\\s+(${IDENT})\\s*=)`, 'gm');

class BundleError extends Error {}

const rel = (abs) => relative(ROOT, abs).split(sep).join('/');
const lineOf = (src, index) => src.slice(0, index).split('\n').length;

/** "a, b as c" -> [{ imported: 'a', local: 'a' }, { imported: 'b', local: 'c' }] */
function parseSpecifiers(list, where) {
  return list.split(',').map((s) => s.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()).filter(Boolean).map((s) => {
    const m = s.match(new RegExp(`^(${IDENT})(?:\\s+as\\s+(${IDENT}))?$`));
    if (!m) throw new BundleError(`${where}: unsupported import/export specifier "${s}"`);
    return { imported: m[1], local: m[2] || m[1] };
  });
}

/** Parse one module: its imports, exports and the body with import/export syntax removed. */
function parseModule(abs) {
  const name = rel(abs);
  let src = readFileSync(abs, 'utf8').replace(/\r\n?/g, '\n');
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);
  const imports = []; // { source, specifiers?, default?, namespace?, line }
  const reexports = []; // { source, specifiers }
  const exports = []; // { exported, local }
  const cuts = []; // [start, end, replacement]

  const at = (m) => `${name}:${lineOf(src, m.index)}`;
  for (const m of src.matchAll(RE_IMPORT_NAMED)) {
    imports.push({ source: m[3], specifiers: parseSpecifiers(m[1], at(m)), line: at(m) });
    cuts.push([m.index, m.index + m[0].length, null]);
  }
  for (const m of src.matchAll(RE_IMPORT_DEFAULT)) {
    imports.push({ source: m[4], default: m[1], specifiers: m[2] ? parseSpecifiers(m[2], at(m)) : [], line: at(m) });
    cuts.push([m.index, m.index + m[0].length, null]);
  }
  for (const m of src.matchAll(RE_IMPORT_NS)) {
    imports.push({ source: m[3], namespace: m[1], specifiers: [], line: at(m) });
    cuts.push([m.index, m.index + m[0].length, null]);
  }
  for (const m of src.matchAll(RE_EXPORT_FROM)) {
    const specifiers = parseSpecifiers(m[1], at(m));
    reexports.push({ source: m[3], specifiers, line: at(m) });
    cuts.push([m.index, m.index + m[0].length, null]);
  }
  // Exported `let` / `var` bindings are live in ESM; destructured imports in the
  // bundle would be snapshots, so refuse them rather than change behaviour.
  const liveBinding = (local, where) => {
    if (new RegExp(`^(?:export\\s+)?(?:let|var)\\s+${local.replace(/\$/g, '\\$')}\\b`, 'm').test(src)) {
      throw new BundleError(`${where}: exported let/var "${local}" (a live binding) cannot be bundled; export a const or a function`);
    }
  };
  for (const m of src.matchAll(RE_EXPORT_LIST)) {
    for (const s of parseSpecifiers(m[1], at(m))) {
      liveBinding(s.imported, at(m));
      exports.push({ exported: s.local, local: s.imported });
    }
    cuts.push([m.index, m.index + m[0].length, null]);
  }
  for (const m of src.matchAll(RE_EXPORT_DECL)) {
    const local = m[2] || m[3] || m[5];
    if (m[4] === 'let' || m[4] === 'var') liveBinding(local, at(m));
    exports.push({ exported: local, local });
    cuts.push([m.index, m.index + 'export'.length + (m[0].slice(6).length - m[0].slice(6).trimStart().length), '']);
  }

  // Anything that looks like module syntax but was not understood: fail.
  const covered = (i) => cuts.some(([s, e]) => i >= s && i < e);
  for (const m of src.matchAll(/^[ \t]*(import|export)\b[^\n]*/gm)) {
    const start = m.index + (m[0].length - m[0].trimStart().length);
    if (!covered(start)) throw new BundleError(`${at(m)}: unsupported module syntax: ${m[0].trim()}`);
  }
  const code = src.replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/[^\n]*/g, '$1'); // rough comment strip for the checks below
  const dyn = code.match(/\bimport\s*\(|\bimport\.meta\b|\brequire\s*\(/);
  if (dyn) throw new BundleError(`${name}:${lineOf(code, dyn.index)}: "${dyn[0]}" cannot be bundled`);

  for (const e of exports) {
    if (exports.filter((x) => x.exported === e.exported).length > 1) throw new BundleError(`${name}: "${e.exported}" is exported twice`);
  }

  cuts.sort((a, b) => b[0] - a[0]);
  let body = src;
  for (const [s, e, r] of cuts) {
    if (r === '') body = body.slice(0, s) + body.slice(e); // drop the `export ` keyword only
    else body = body.slice(0, s) + body.slice(e).replace(/^\n/, ''); // drop the whole statement line
  }
  return { abs, name, imports, reexports, exports, body };
}

const isRelative = (s) => s.startsWith('./') || s.startsWith('../');
const isBuiltin = (s) => s.startsWith('node:');
const varName = (name) => `__iluboard_${name.replace(/\.m?js$/, '').replace(/[^A-Za-z0-9]/g, '_')}`;
const nodeVar = (source) => `__node_${source.slice(5).replace(/[^A-Za-z0-9]/g, '_')}`;

/**
 * Bundle `entry` (relative to root) and return the file text.
 * @param {{ root?: string, entry?: string, version?: string }} opts
 */
export function bundle(opts = {}) {
  const root = opts.root ? resolve(opts.root) : ROOT;
  const entryAbs = resolve(root, opts.entry || ENTRY);
  const version = opts.version ?? readVersion(root);
  const mods = new Map(); // abs -> parsed
  const order = []; // dependency order (post-order DFS, imports in source order)
  const visiting = new Set();

  const visit = (abs, from) => {
    if (mods.has(abs)) return;
    if (visiting.has(abs)) throw new BundleError(`import cycle through ${rel(abs)} (from ${from}); cycles are not supported`);
    visiting.add(abs);
    let m;
    try { m = parseModule(abs); } catch (e) {
      if (e instanceof BundleError) throw e;
      throw new BundleError(`cannot read ${rel(abs)}${from ? ` (imported by ${from})` : ''}: ${e.message}`);
    }
    for (const d of [...m.imports, ...m.reexports]) {
      if (isBuiltin(d.source)) {
        if (m.reexports.includes(d)) throw new BundleError(`${d.line}: re-exporting from ${d.source} is not supported`);
        continue;
      }
      if (!isRelative(d.source)) throw new BundleError(`${d.line}: only relative and node: imports can be bundled ("${d.source}")`);
      if (!/\.m?js$/.test(d.source)) throw new BundleError(`${d.line}: import paths need an explicit .js extension ("${d.source}")`);
      if (d.default || d.namespace) throw new BundleError(`${d.line}: default / namespace imports of local modules are not supported ("${d.source}")`);
      d.abs = resolve(dirname(abs), d.source);
      // Back edge of an import cycle: the target runs later, so its names are bound once it has.
      if (visiting.has(d.abs)) { d.deferred = true; continue; }
      visit(d.abs, m.name);
    }
    visiting.delete(abs);
    mods.set(abs, m);
    order.push(m);
  };
  visit(entryAbs, null);

  // Check that every imported / re-exported name exists.
  const exportedNames = (m) => new Set([...m.exports.map((e) => e.exported), ...m.reexports.flatMap((r) => r.specifiers.map((s) => s.local))]);
  for (const m of order) {
    for (const d of [...m.imports, ...m.reexports]) {
      if (!d.abs) continue;
      const target = mods.get(d.abs);
      const names = exportedNames(target);
      for (const s of d.specifiers) {
        if (!names.has(s.imported)) throw new BundleError(`${d.line}: ${target.name} does not export "${s.imported}"`);
      }
    }
  }

  // node: builtins, de-duplicated, sorted for a stable header.
  const builtins = [...new Set(order.flatMap((m) => m.imports.filter((d) => isBuiltin(d.source)).map((d) => d.source)))].sort();

  const importLines = (m) => {
    const lines = [];
    for (const d of m.imports) {
      const from = isBuiltin(d.source) ? nodeVar(d.source) : varName(mods.get(d.abs).name);
      if (d.namespace) lines.push(`const ${d.namespace} = ${from};`);
      if (d.default) lines.push(`const ${d.default} = ${from}.default;`);
      if (!d.specifiers.length) continue;
      const list = d.specifiers.map((s) => (s.local === s.imported ? s.local : `${s.imported}: ${s.local}`)).join(', ');
      if (d.deferred) {
        lines.push(`let ${d.specifiers.map((s) => s.local).join(', ')}; // import cycle: bound once ${mods.get(d.abs).name} has run`);
        lines.push(`(__iluboard_late.${from} ||= []).push(() => { ({ ${list} } = ${from}); });`);
      } else lines.push(`const { ${list} } = ${from};`);
    }
    return lines;
  };

  const out = [];
  out.push('#!/usr/bin/env node');
  out.push(`// IluBoard CLI, single file — generated by tools/bundle.mjs from IluBoard v${version} — do not edit.`);
  out.push('// Source: https://github.com/ilumetric/IluBoard (tools/iluboard.mjs + src/core/*). Regenerate: npm run bundle');
  out.push('// Usage: node iluboard.mjs --help   (Node 20+, no dependencies)');
  out.push(`// Modules: ${order.map((m) => m.name).join(', ')}`);
  out.push('');
  for (const b of builtins) out.push(`import * as ${nodeVar(b)} from '${b}';`);
  const lateTargets = new Set(order.flatMap((m) => m.imports.filter((d) => d.deferred && d.specifiers.length).map((d) => d.abs)));
  if (lateTargets.size) {
    out.push('', '// Import cycles: these names are bound right after the imported module has run', '// (as in ESM, they may only be used at call time, not while the importing module loads).');
    out.push('const __iluboard_late = {};');
  }

  for (const m of order) {
    if (m.abs === entryAbs) continue;
    if (m.exports.length === 0 && m.reexports.length === 0) throw new BundleError(`${m.name} exports nothing`);
    out.push('');
    out.push(`// ---- ${m.name} ${'-'.repeat(Math.max(4, 72 - m.name.length))}`);
    out.push(`const ${varName(m.name)} = (() => {`);
    out.push(...importLines(m));
    out.push(m.body.replace(/^\n+/, '').replace(/\s+$/, ''));
    const props = [];
    for (const e of m.exports) props.push(`  ${e.exported === e.local ? e.local : `${e.exported}: ${e.local}`},`);
    for (const r of m.reexports) {
      const from = varName(mods.get(r.abs).name);
      for (const s of r.specifiers) props.push(`  get ${s.local}() { return ${from}.${s.imported}; },`);
    }
    out.push('return {');
    out.push(...props);
    out.push('};');
    out.push('})();');
    if (lateTargets.has(m.abs)) out.push(`for (const bind of __iluboard_late.${varName(m.name)}) bind();`);
  }

  const entry = mods.get(entryAbs);
  if (entry.exports.length || entry.reexports.length) throw new BundleError(`${entry.name}: the entry must not export anything`);
  out.push('');
  out.push(`// ---- ${entry.name} ${'-'.repeat(Math.max(4, 72 - entry.name.length))}`);
  out.push(...importLines(entry));
  out.push(entry.body.replace(/^\n+/, '').replace(/\s+$/, ''));
  return `${out.join('\n')}\n`;
}

function readVersion(root) {
  const src = readFileSync(join(root, 'src/core/version.js'), 'utf8');
  const m = src.match(/APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
  if (!m) throw new BundleError('APP_VERSION not found in src/core/version.js');
  return m[1];
}

function main(argv) {
  const check = argv.includes('--check');
  const toStdout = argv.includes('--stdout');
  let text;
  try { text = bundle(); } catch (e) {
    process.stderr.write(`bundle: ${e.message}\n`);
    return 1;
  }
  const outPath = join(ROOT, OUTPUT);
  if (toStdout) { process.stdout.write(text); return 0; }
  let current = null;
  try { current = readFileSync(outPath, 'utf8'); } catch { /* missing */ }
  if (check) {
    const ok = current === text;
    process.stdout.write(ok ? `${OUTPUT}: up to date\n` : `${OUTPUT}: out of date (run: npm run bundle)\n`);
    return ok ? 0 : 1;
  }
  if (current === text) { process.stdout.write(`${OUTPUT}: already up to date (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)\n`); return 0; }
  writeFileSync(outPath, text);
  process.stdout.write(`wrote ${OUTPUT} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)\n`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = main(process.argv.slice(2));
