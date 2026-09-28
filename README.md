# IluBoard

**Канбан-доска, у которой источник правды — один `board.json` в git-репозитории.**
*A kanban board whose source of truth is one `board.json` in your git repo.*

Человек двигает карточки в браузере и сохраняет в тот же файл. AI-агент читает и
правит файл на диске через CLI из одного файла. Ни сервера, ни аккаунтов, ни
облака, ни базы данных — только файл, который лежит рядом с остальными
документами проекта и нормально выглядит в `git diff`.

**Доска:** https://ilumetric.github.io/IluBoard/ · **Демо:** https://ilumetric.github.io/IluBoard/?demo

- **Веб-интерфейс в духе ChatGPT:** тихий сайдбар, колонки идея / к работе /
  в работе / готово / отменено, drag-n-drop между колонками и внутри колонки
  (мышь, тач, клавиатура: Alt+стрелки), быстрое добавление карточки строкой
  снизу, фильтры по исполнителю и приоритету, поиск, undo/redo, тёмная и
  светлая тема, русский и английский.
- **Файл — единственная правда.** *Открыть папку* → приложение находит
  `board.json` (например, `Studio/planning/board.json`) → *Сохранить* пишет в тот
  же файл (File System Access API: Chrome, Edge). В браузере хранятся только
  настройки интерфейса и список недавних файлов.
- **Не затирает чужие правки.** Приложение раз в пару секунд проверяет файл.
  Если агент его поменял, а у вас нет несохранённых правок — доска тихо
  перечитывается и подсвечивает изменения. Если правки есть — появляется
  предупреждение: *Объединить* (по карточкам и полям), *Перечитать* или
  *Перезаписать*. Перед записью файл сверяется ещё раз.
- **Удобно агенту:** стабильные id (`B8`), канонический формат (порядок ключей,
  одно поле на строку, карточки по колонке и `order`), `updated_by: human|agent`,
  CLI `iluboard.mjs` без зависимостей: `text`, `diff --git`, `validate`, `fmt`,
  `move`, `add`, `set`, `md`.

## Для агента

```bash
curl -O https://ilumetric.github.io/IluBoard/iluboard.mjs
node iluboard.mjs text Studio/planning/board.json
node iluboard.mjs diff Studio/planning/board.json --git
node iluboard.mjs move Studio/planning/board.json B8 done
node iluboard.mjs add Studio/planning/board.json --title "…" --column todo --done-when "…"
node iluboard.mjs md Studio/planning/board.json --out Studio/planning/backlog.md
```

Подробно: [docs/AGENT.md](docs/AGENT.md) · формат: [docs/FORMAT.md](docs/FORMAT.md) ·
схема: [schema/board.schema.json](schema/board.schema.json).

## Как пользоваться

1. Откройте https://ilumetric.github.io/IluBoard/ в Chrome или Edge.
2. *Открыть папку проекта* → выберите репозиторий. Если `board.json` ещё нет —
   приложение предложит создать его (или `node iluboard.mjs init board.json`).
3. Двигайте карточки, кликом открывайте и редактируйте, `N` — новая карточка,
   `/` или `Ctrl+K` — поиск, `Ctrl+S` — сохранить, `Ctrl+Z` — отменить.
4. Закоммитьте `board.json` как обычный файл.

Перенос карточки в «к работе» или «в работе» просит критерий готовности
(`done_when`) — без него CLI откажется менять файл.

**Firefox, Safari, встроенные браузеры** не умеют писать в открытый файл:
там *Сохранить* скачивает `board.json`. Для встроенного браузера (например, в
приложении Claude) есть локальный сервер — он пишет файл напрямую:

```bash
node tools/serve.mjs ../Project_RUN --open Studio/planning/board.json
# http://localhost:8787/?file=Studio/planning/board.json
```

Сервер слушает только 127.0.0.1 и пишет только `*.json` внутри указанной папки.
Он необязателен: GitHub Pages работает без него.

## Разработка

Без сборки и зависимостей, Node 20+.

```bash
npm test               # node --test: модель, diff, слияние, CLI (исходник и бандл), сервер
npm run bundle         # собрать iluboard.mjs из tools/iluboard.mjs + src/core/*
npm run serve          # локальный сервер на текущей папке
```

```
index.html            страница приложения (GitHub Pages отдаёт корень репозитория)
src/core/             чистые модули без DOM: модель и валидация, text/md, diff, слияние
src/app/              интерфейс: main.js, disk.js (файлы), ui.js, i18n.js, icons.js, styles.css
tools/iluboard.mjs    CLI (исходник)      iluboard.mjs   CLI одним файлом (генерируется)
tools/serve.mjs       локальный сервер    tools/bundle.mjs  сборщик бандла
schema/  docs/  examples/  test/
```

GitHub Pages: *Settings → Pages → Deploy from a branch → `main` / `(root)`*.
Файл `.nojekyll` нужен, чтобы `docs/*.md` и `iluboard.mjs` отдавались как есть.

## Лицензия

MIT
