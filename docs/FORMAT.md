# board.json — format reference (version 1)

One JSON object. The file is always written in a **canonical form** (by the
web app on Save and by every CLI write command, or by `iluboard.mjs fmt`) so
that git diffs stay small and readable:

* keys in a fixed order (below), then custom `x_…` keys in their original order;
* one field per line; `columns` and `tags` on one line;
* cards sorted by column (in `columns` order), then by `order`;
* `order` renumbered 0, 1, 2… inside every column;
* empty optional fields (`""`, `[]`) dropped;
* 2-space indent, `\n` line ends, trailing newline.

```json
{
  "format": "iluboard",
  "version": 1,
  "meta": {
    "title": "Project RUN",
    "id_prefix": "B",
    "updated": "2026-09-28"
  },
  "columns": ["idea", "todo", "doing", "done", "dropped"],
  "cards": [
    {
      "id": "B8",
      "title": "Тест пайплайна: ковш → Substance без high-poly",
      "column": "doing",
      "order": 0,
      "priority": "P0",
      "size": "M",
      "owner": "max",
      "goal": "3b",
      "done_when": "Макс посмотрел и сказал да/нет",
      "notes": "Результат — решение в Studio/decisions.md",
      "tags": ["арт"],
      "due": "2026-10-12",
      "updated": "2026-09-28",
      "updated_by": "agent"
    }
  ]
}
```

## Top level

| key | type | |
|---|---|---|
| `format` | `"iluboard"` | required |
| `version` | `1` | required |
| `meta` | object | optional, see below |
| `columns` | string[] | required, non-empty, unique. Column ids in display order |
| `cards` | card[] | required |
| `x_…` | any | custom, kept as is |

## meta

| key | type | |
|---|---|---|
| `title` | string | board title in the app |
| `id_prefix` | string | prefix of generated ids (`B` → `B15`). Without it, the most common prefix of the existing ids is used |
| `updated` | `YYYY-MM-DD` | set when the board is saved or changed by the CLI |

## Columns

Standard set: `idea`, `todo`, `doing`, `done`, `dropped` — shown as
идея / к работе / в работе / готово / отменено (Idea / To do / Doing / Done /
Dropped in English). Other ids are allowed and shown as they are. `todo` and
`doing` require `done_when`; `done` and `dropped` are "closed" (no overdue
warnings, muted in the app).

## Card

| key | type | |
|---|---|---|
| `id` | string | required, unique, `[A-Za-z0-9][A-Za-z0-9_.-]*`. Stable: never renamed — documents link to cards by id |
| `title` | string | required, non-empty |
| `column` | string | required, one of `columns` |
| `order` | integer ≥ 0 | position inside the column, 0 = top |
| `priority` | `P0` \| `P1` \| `P2` \| `P3` | |
| `size` | `S` \| `M` \| `L` \| `XL` | |
| `owner` | string | free text: `max`, `producer`, `narrative`, `design`, `code`… |
| `goal` | string | milestone from `Studio/planning/roadmap.md`: `3a`, `3b`… |
| `done_when` | string | the criterion of done; **required in `todo` and `doing`** |
| `notes` | string | multi-line allowed |
| `tags` | string[] | |
| `due` | `YYYY-MM-DD` | |
| `updated` | `YYYY-MM-DD` | last change of this card |
| `updated_by` | `human` \| `agent` | who made it: the web app writes `human`, the CLI `agent` |
| `x_…` | any | custom, kept as is |

Unknown keys without the `x_` prefix are kept too, but `validate` warns about them.

## Validation

`node iluboard.mjs validate board.json` (exit 1 on errors):

* `format`, `version`, `columns`, `cards` present and of the right type;
* ids present, well-formed and unique;
* `title` non-empty; `column` listed in `columns`;
* `priority`, `size`, `updated_by` from their sets; dates are real `YYYY-MM-DD` dates;
* `done_when` present in `todo` / `doing`;
* warnings for unknown non-`x_` fields.

The machine-checkable shape is in
[schema/board.schema.json](../schema/board.schema.json) (JSON Schema 2020-12);
uniqueness of ids and "column is one of `columns`" are only checked by the CLI.
