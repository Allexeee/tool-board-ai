# tool-board-ai

Доска карточек для владельца и ИИ-агентов. Одна сущность — карточка: сначала запрос, после разбора и утверждения — задача. Карточки берутся в забеги, выполняются, сдаются на ревью и заливаются в `main`.

Требуется Node 24 или новее: встроенный `node:sqlite` и запуск TypeScript без сборки. Внешних зависимостей нет.

## Установка

CLI ставится один раз; в каждый проект его класть не нужно.

```powershell
# скопируйте/клонируйте этот репозиторий (ветку с доской) в удобное место
git clone https://github.com/Allexeee/tool-board-ai.git "$env:USERPROFILE\tools\tool-board-ai"
$env:Path += ";$env:USERPROFILE\tools\tool-board-ai"
```

В корне лежит `board.cmd`; он запускает `node bin\board.ts`. Проверка:
`board --version`.

Скилл `board` и команды `/review`, `/setup` вызывают `board`, поэтому CLI
должен быть в `PATH` (хотя бы в окружении, из которого стартует OpenCode). Если не хотите
менять `PATH` глобально, запускайте CLI как `node <путь>\bin\board.ts ...`;
`BOARD_CLI` перекрывает путь только для инструментов плагина:

```powershell
[Environment]::SetEnvironmentVariable('BOARD_CLI', "$env:USERPROFILE\tools\tool-board-ai\bin\board.ts", 'User')
```

`npm install` из git не работает: Node не обрабатывает TypeScript внутри `node_modules`. Запуск идёт из обычного каталога.

## Установка в существующий проект

Старый `toolbox-al` или `.toolbox-al` в проекте не нужен. `init` создаёт
новую доску с нуля и не переносит старые данные.

В корне существующего проекта:

```bash
git checkout -b dev          # если ветки dev ещё нет
board init                   # или: node <путь>\bin\board.ts init
git add -A
git commit -m "chore: board init"
board executor add developer --kind agent --skills dev
board doctor
board now
```

Первый `init` в терминале запускает мастер настроек: спрашивает, включать ли
ревью после каждого забега. По умолчанию выключено. Если `init` запускал агент
(не-TTY), мастер не спрашивает — вызовите `/setup` в OpenCode или `board setup`
в терминале.

`init` создаёт:

- `.board/board.db` — базу (истина доски) и исполнителя `owner`;
- `.board/settings.json` — локальные настройки (в git не попадает);
- `docs/board/terminology.md` — термины и команды владельца;
- `.opencode/skills/board/SKILL.md`, `.opencode/plugins/board/index.ts`,
  `.opencode/command/review.md`, `.opencode/command/setup.md` — интеграция с
  OpenCode;
- блок `board` в `AGENTS.md`;
- записи `.board/`, `.worktrees/` в `.gitignore`.

Скелет нужно закоммитить: `finish` мержит в `dev` и требует чистое основное
дерево. `.board/` в git не попадает, `main` меняется только `release`.

После обновления CLI обновите сгенерированную интеграцию:

```bash
board init --refresh
```

Команда перезапишет `.opencode/skills/board/SKILL.md`, плагин и команды
`/review`/`/setup` текущими шаблонами, сохранив остальной `AGENTS.md`. Если вы
правили эти файлы руками, изменения будут потеряны.

В примерах ниже `board` — CLI из `PATH`. Если запускаете из исходников,
замените его на `node <путь>\bin\board.ts`.

## Карточка

Создавать может кто угодно, выполнять — только носитель нужного навыка.

```bash
board card add --group UI --title "Форма входа" --skill dev
```

- **Запрос** (`phase=request`) → разбор: `card shape UI-1 --as developer [--from card.json]`.
- **На утверждение**: `card submit UI-1 --as developer`.
- Владелец: `card approve UI-1` или `card reject UI-1 --reason "..."`.

Разбирающий заполняет body, шаги (`card step`), навык, `importance`/`urgency` (оценка 0–9), `needs_merge`, `review_required`, `scope`, зависимости (`card dep`).

## Очередь и забег

После утверждения карточка встаёт в очередь задач по оценке. `now 3` показывает запросы и очередь; `now 1` — текущий забег и вероятные следующие, `now 2` — все забеги.

```bash
board run start --as developer --cards UI-1,UI-7   # или --suggest 1
board take UI-1 --as developer
board finish UI-1 --as developer --summary "готово"
board run next --as developer
board run end --as developer [--review|--no-review]
```

`take` создаёт ветку `card/UI-1` и worktree `.worktrees/developer`; `finish` проверяет `scope` и мержит ветку в `dev` (`--no-ff`), затем ставит `review` (если `review_required`) или `done`.

Если нужен владелец — `block UI-1 --as developer --reason needs_decision --note "..."` или `ask UI-1 "вопрос" --as developer [--block]`. Ответ — `answer UI-1 "ответ"`.

## Ревью

`board review list --json` отдаёт карточки на ревью (body, шаги, scope, diff). Команда `/review` в OpenCode запускает свежего субагента, который выносит вердикт по каждой:

```bash
board review submit UI-1 --verdict done --note "..." --reviewer review
board review finding UI-1 --severity critical --text "..."
```

CLI субагентов не порождает — он готовит пакет и принимает вердикты. Находки ревью становятся запросами; `critical` блокирует `main`, пока не закрыта.

## Настройки

Настройки лежат в `.board/settings.json` и не попадают в git. Мастер
запускается один раз при первом `init`; позже его можно вызвать вручную
командой `/setup` или `board setup`.

```bash
board setup --show                      # текущие настройки
board setup --review-after-run          # включить ревью после каждого забега
board setup --no-review-after-run       # выключить (по умолчанию)
```

`run end` берёт значение из настройки; флаги `--review`/`--no-review`
перекрывают её для конкретного забега. Включённое ревью не блокирует закрытие
забега: агент запускает `/review` после `run end`.

## Релиз

`release` — команда владельца: проверяет, что в `dev` нет незавершённых карточек и открытых `critical`-находок, и мержит `dev` в `main` (`--no-ff`).

```bash
board release
```

## Доска

```bash
board now      # вкладка 3: открытые карточки
board now 0    # владельцу: утвердить, owner-задачи, вопросы
board now 1    # текущий забег и вероятные следующие
board now 2    # все забеги
```

Фильтры: `--group UI`, `--skill dev`, `--status ready,waiting`, `--mine`, `--phase request`, `--limit`, `--all`. Все команды принимают `--json`.

## Решения и терминология

- `docs/board/decisions.md` — общий журнал решений и допущений; пишется командой `decision` и перезаписывается атомарно.
- `docs/board/terminology.md` — живой документ (источник истины для языка проекта); читают все, термины пишут все, команды владельца — только owner.

```bash
board decision add UI-1 "Используем VK API" --kind decision --as developer
board term add "забег" "сессия агента над 1–3 карточками" --as developer
board command add "RUN" "начать забег по очереди" --as owner
```

## Git (вариант B)

- Ветки: `main` и `dev`. Карточка живёт в `card/<ID>` внутри worktree `.worktrees/<executor>`.
- `finish` мержит в `dev`; `release` — в `main`. Состояние `in_dev`/`in_main` читается из git.
- `card cancel` на влитой карточке создаёт revert-коммит; `card reopen` открывает новую попытку с новой веткой.
- Карточки без мержа (`needs_merge=false`) git не трогают.
- `finish --no-merge` — аварийный путь для нестандартного мержа; проверки scope остаются.

## Команды

| Команда | Что делает |
|---|---|
| `init [каталог] [--yes] [--refresh]` | скелет проекта, мастер настроек и обновление `.opencode` |
| `setup [--show\|--review-after-run\|--no-review-after-run]` | настройки доски |
| `executor add\|list\|edit\|remove` | исполнители и навыки |
| `card add\|list\|show\|edit` | карточки |
| `card shape\|submit\|approve\|reject\|verdict\|done\|cancel\|reopen` | жизненный цикл |
| `card step add\|done\|remove\|list` | шаги-чек-лист |
| `card ref add\|remove\|list` | ссылки и документы |
| `card dep add\|remove\|list` | зависимости |
| `queue move\|reorder` | порядок очереди |
| `run start\|add\|drop\|next\|end\|release\|list` | забеги |
| `take\|finish\|block\|touch` | выполнение |
| `ask\|answer` | вопросы владельцу |
| `decision add\|list\|supersede\|obsolete` | журнал решений |
| `term add\|list\|show` | терминология |
| `command add\|list` | команды владельца |
| `review list\|finding\|submit` | пакет и вердикты ревью |
| `release` | слить `dev` в `main` |
| `now [0\|1\|2\|3]` | терминальная доска |
| `doctor` | диагностика |

Коды выхода: `0` — успех, `1` — делать нечего, `2` — нужно решение владельца, `3` — ошибка.

## OpenCode

`init` создаёт скилл `board`, плагин с инструментами `board_now`, `board_setup`, `board_card`, `board_run`, `board_take`, `board_finish`, `board_block`, `board_ask`, `board_answer`, `board_review`, `board_decision`, `board_term`, команды `/review` и `/setup`. Плагин не содержит логики: он вызывает `board … --json`. Файлы исполнителей-агентов настраиваются руками в `.opencode/agents/<id>.md`.
