# toolbox-al

Доска карточек для владельца и ИИ-агентов. Одна сущность — карточка: сначала запрос, после разбора и утверждения — задача. Карточки берутся в забеги, выполняются, сдаются на ревью и заливаются в `main`.

Требуется Node 24 или новее: встроенный `node:sqlite` и запуск TypeScript без сборки. Внешних зависимостей нет.

## Установка

Клонировать один раз и положить в `PATH`:

```powershell
git clone https://github.com/Allexeee/toolbox-al.git "$env:USERPROFILE\tools\toolbox-al"
$env:Path += ";$env:USERPROFILE\tools\toolbox-al"
```

Дальше в любом проекте: `board init`.

`npm install` из git не работает: Node отказывается обрабатывать TypeScript внутри `node_modules`. Запуск идёт из обычного каталога.

## Первый запуск на проекте

```bash
node bin/board.ts init
```

Что создаёт `init`:

- `.board/board.db` — база (источник истины доски) и исполнитель `owner`;
- `docs/board/terminology.md` — термины и команды владельца;
- `.opencode/skills/board/SKILL.md`, `.opencode/plugins/board/index.ts`, `.opencode/command/review.md` — интеграция с OpenCode;
- блок `board` в `AGENTS.md`;
- записи `.board/`, `.worktrees/` в `.gitignore`.

Затем:

```bash
node bin/board.ts executor add developer --kind agent --skills dev
git branch dev        # если ветки ещё нет
```

`doctor` скажет, чего не хватает.

## Карточка

Создавать может кто угодно, выполнять — только носитель нужного навыка.

```bash
node bin/board.ts card add --group UI --title "Форма входа" --skill dev
```

- **Запрос** (`phase=request`) → разбор: `card shape UI-1 --as developer [--from card.json]`.
- **На утверждение**: `card submit UI-1 --as developer`.
- Владелец: `card approve UI-1` или `card reject UI-1 --reason "..."`.

Разбирающий заполняет body, шаги (`card step`), навык, `importance`/`urgency` (оценка 0–9), `needs_merge`, `review_required`, `scope`, зависимости (`card dep`).

## Очередь и забег

После утверждения карточка встаёт в очередь задач по оценке. `now 3` показывает запросы и очередь; `now 1`/`now 2` — вероятные забеги.

```bash
node bin/board.ts run start --as developer --cards UI-1,UI-7   # или --suggest 1
node bin/board.ts take UI-1 --as developer
node bin/board.ts finish UI-1 --as developer --summary "готово"
node bin/board.ts run next --as developer
node bin/board.ts run end --as developer [--review]
```

`take` создаёт ветку `card/UI-1` и worktree `.worktrees/developer`; `finish` проверяет `scope` и мержит ветку в `dev` (`--no-ff`), затем ставит `review` (если `review_required`) или `done`.

Если нужен владелец — `block UI-1 --as developer --reason needs_decision --note "..."` или `ask UI-1 "вопрос" --as developer [--block]`. Ответ — `answer UI-1 "ответ"`.

## Ревью

`board review list --json` отдаёт карточки на ревью (body, шаги, scope, diff). Команда `/review` в OpenCode запускает свежего субагента, который выносит вердикт по каждой:

```bash
node bin/board.ts review submit UI-1 --verdict done --note "..." --reviewer review
node bin/board.ts review finding UI-1 --severity critical --text "..."
```

CLI субагентов не порождает — он готовит пакет и принимает вердикты. Находки ревью становятся запросами; `critical` блокирует `main`, пока не закрыта.

## Релиз

`release` — команда владельца: проверяет, что в `dev` нет незавершённых карточек и открытых `critical`-находок, и мержит `dev` в `main` (`--no-ff`).

```bash
node bin/board.ts release
```

## Доска

```bash
node bin/board.ts now      # вкладка 3: открытые карточки
node bin/board.ts now 0    # владельцу: утвердить, owner-задачи, вопросы
node bin/board.ts now 1    # мои забеги
node bin/board.ts now 2    # все забеги
```

Фильтры: `--group UI`, `--skill dev`, `--status ready,waiting`, `--mine`, `--phase request`, `--limit`, `--all`. Все команды принимают `--json`.

## Решения и терминология

- `docs/board/decisions.md` — общий журнал решений и допущений; пишется командой `decision` и перезаписывается атомарно.
- `docs/board/terminology.md` — живой документ (источник истины для языка проекта); читают все, термины пишут все, команды владельца — только owner.

```bash
node bin/board.ts decision add UI-1 "Используем VK API" --kind decision --as developer
node bin/board.ts term add "забег" "сессия агента над 1–3 карточками" --as developer
node bin/board.ts command add "RUN" "начать забег по очереди" --as owner
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
| `init [каталог]` | скелет проекта |
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

`init` создаёт скилл `board`, плагин с инструментами `board_now`, `board_card`, `board_run`, `board_take`, `board_finish`, `board_block`, `board_ask`, `board_answer`, `board_review`, `board_decision`, `board_term` и команду `/review`. Плагин не содержит логики: он вызывает `node bin/board.ts … --json`. Файлы исполнителей-агентов настраиваются руками в `.opencode/agents/<id>.md`.
