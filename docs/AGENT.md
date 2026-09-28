# Using IluBoard as an AI agent

You do not need the browser. `board.json` is the whole board; a single-file
CLI reads, checks, describes, edits and compares it. If all you have is the
site URL (https://ilumetric.github.io/IluBoard/), start here.

## Get the CLI

One file, no dependencies, Node 20+:

```bash
curl -O https://ilumetric.github.io/IluBoard/iluboard.mjs
node iluboard.mjs --version        # iluboard <version> (board format v1)
node iluboard.mjs --help           # the source of truth for commands and options
```

`iluboard.mjs` is generated from `tools/iluboard.mjs` and `src/core/*`
(inside a clone of the repo, `node tools/iluboard.mjs …` is the same thing).

## Commands

```bash
# read
node iluboard.mjs text board.json                  # the board in words, one line per card
node iluboard.mjs text board.json --full           # + goal, done_when, notes, tags, last edit
node iluboard.mjs text board.json --columns todo,doing
node iluboard.mjs md board.json --out backlog.md   # Markdown tables (backlog.md is an export)
node iluboard.mjs validate board.json              # exit 1 on errors (--json for machine output)
node iluboard.mjs diff board.json --git            # what changed since HEAD (or --git <rev>)
node iluboard.mjs diff old.json new.json

# write: re-read → change → validate → write the canonical file (nothing is written if invalid)
node iluboard.mjs fmt board.json                   # canonical format (--check: exit 1 if not)
node iluboard.mjs move board.json B8 done          # bottom of the column (--top, --index N)
node iluboard.mjs move board.json B12 doing --done-when "Max said yes"
node iluboard.mjs add board.json --title "…" --column todo --priority P1 --size M \
     --owner max --goal 3b --done-when "…" --notes "…" --tags art,tech --due 2026-10-12
node iluboard.mjs set board.json B9 --priority P0 --notes ""   # "" removes a field
node iluboard.mjs init board.json --title "Project RUN" --prefix B
```

Options everywhere: `--lang ru|en` (text, md, diff and messages; default `ru`,
or the `ILUBOARD_LANG` environment variable) and `--by agent|human` (who is
written to `updated_by`; the CLI defaults to `agent`, the browser writes `human`).

`text` prints one line per card:

```
## в работе (doing) — 2
- B8 [P0/M] max — Тест пайплайна: ковш → Substance без high-poly (до 2026-10-12)
- B7 [P1/S] code — Камера от третьего лица: коллизии со стенами (до 2026-09-30)
```

`diff --git` tells what the human did since the last commit:

```
## Перенесены (1)

- B8 Тест пайплайна: ковш → Substance без high-poly: в работе → готово · human

## Новые (1)

- B15 [P2] max — Звук шагов по гравию — в «идея» · human

## Изменены (1)

- B9 Черновик диалогов пролога · human: priority "P1" → "P0"
```

`add` without `--id` takes the next id with the board's prefix (`meta.id_prefix`,
or the most common prefix of the existing ids): B14 → B15.

## The loop with a human

1. **Human** opens https://ilumetric.github.io/IluBoard/ in Chrome or Edge →
   *Open folder* (the repo) → the app finds `Studio/planning/board.json` →
   drags cards, edits them, presses *Save* (Ctrl+S). The file is rewritten in
   the canonical format; changed cards get `"updated_by": "human"`.
2. **Agent** starts its session with `node iluboard.mjs diff board.json --git`,
   sees what was closed or moved, rebuilds `todo` with `move` / `add` / `set`,
   runs `md board.json --out backlog.md` if the backlog export is used, and
   commits `board.json` (and `backlog.md`).
3. While the board is open in the browser, the app checks the file every two
   seconds. If the human has no unsaved edits it reloads silently and
   highlights what changed; if they do, it shows a banner and offers
   *Merge* (card by card, field by field), *Reload* or *Overwrite*. It never
   overwrites your changes without asking.

Working next to a human in an embedded browser (e.g. the Claude app), where the
File System Access API cannot write: from a clone of the IluBoard repo run
`node tools/serve.mjs <project folder>` and open
`http://localhost:8787/?file=Studio/planning/board.json`. Save then writes
through the local server.

## File safety

* **Re-read `board.json` right before every edit.** Never keep a copy in memory
  across turns and write it back later — that silently reverts what the human
  did. The CLI's write commands already re-read.
* Change only what you mean to change; prefer `move` / `add` / `set` over
  rewriting the file. Editing the JSON directly is fine too: then run
  `fmt` and `validate`.
* Commit before large edits so `diff --git` can show the result.

## Rules

* `id` is stable: never rename it, documents link to cards by id. Letters,
  digits, `_`, `.`, `-`; unique.
* `column` must be one of `columns`: `idea`, `todo`, `doing`, `done`, `dropped`
  (UI labels: идея / к работе / в работе / готово / отменено).
* Cards in `todo` and `doing` need `done_when` — a concrete criterion, e.g.
  "Макс посмотрел и сказал да/нет". The CLI refuses to write a board without it.
* `priority` P0–P3, `size` S/M/L/XL, `due` and `updated` are `YYYY-MM-DD`,
  `updated_by` is `human` or `agent`, `goal` is a milestone from `roadmap.md`
  (`3a`, `3b`…), `owner` is free text (`max`, `producer`, `narrative`,
  `design`, `code`).
* `order` is the position inside a column; it is renumbered 0, 1, 2… on every
  write — do not try to keep gaps.
* Custom fields start with `x_` and survive round trips.

Full field reference: [FORMAT.md](FORMAT.md); JSON Schema:
[schema/board.schema.json](../schema/board.schema.json).

## Programmatic use

The bundle is a CLI, not a library. From your own code, call the CLI
(`validate --json`, `diff --json`), or clone the repository and import the
pure ES modules in `src/core/` (no DOM, no dependencies):

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { normalize, validate, serialize, moveCard, addCard } from './src/core/model.js';

const doc = normalize(readFileSync('board.json', 'utf8'));  // re-read right before editing
moveCard(doc, 'B8', 'done', 0, { by: 'agent' });
addCard(doc, { title: 'Next step', column: 'todo', done_when: '…' }, { by: 'agent' });
if (!validate(doc).ok) throw new Error('invalid');
writeFileSync('board.json', serialize(doc));
```
