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

Скилл `board` и команды `/review`, `/spec-review`, `/setup` вызывают `board`,
поэтому CLI должен быть в `PATH` (хотя бы в окружении, из которого стартует
OpenCode). Если не хотите
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
  `.opencode/command/review.md`, `.opencode/command/spec-review.md`,
  `.opencode/command/setup.md` — интеграция с OpenCode;
- `.opencode/agents/board-reviewer.md` — локальный read-only ревьюер на
  default-варианте модели (в git не попадает);
- блок `board` в `AGENTS.md`;
- записи `.board/`, `.worktrees/` в `.gitignore`.

Скелет нужно закоммитить: `finish` мержит в `dev` и требует чистое основное
дерево. `.board/` в git не попадает, `main` меняется только `release`.

После обновления CLI обновите сгенерированную интеграцию:

```bash
board init --refresh
```

Команда перезапишет `.opencode/skills/board/SKILL.md`, плагин и команды
`/review`/`/spec-review`/`/setup` текущими шаблонами, сохранив остальной
`AGENTS.md`. Если вы правили эти файлы руками, изменения будут потеряны.

В примерах ниже `board` — CLI из `PATH`. Если запускаете из исходников,
замените его на `node <путь>\bin\board.ts`.

## Карточка

Создавать может кто угодно, выполнять — только носитель нужного навыка.

```bash
board card add --group UI --title "Форма входа" --skill dev
```

- **Запрос** (`phase=request`) → разбор: `card shape UI-1 --as developer [--from card.json]`.
- Разбирающий заполняет **spec** (`body`): проблему/why, результат, non-goals, ограничения, риски и **критерии приёмки** (`acceptance`). План (`steps`) здесь не пишется.
- **Spec review** (если включён): `/spec-review` или `card spec-review UI-1 --as developer --mode self|subagent --verdict done`.
- **Scope** задаётся здесь же: `card edit UI-1 --scope 'src/**' --scope 'tests/**'`.
- **На утверждение**: `card submit UI-1 --as developer`. Владелец утверждает **spec**: `card approve UI-1` или `card reject UI-1 --reason "..."`.
- После approve менять spec/acceptance/scope нельзя; изменение — `card amend UI-1 --as developer --reason "..."`, затем повторный review и approve.
- `card reopen` — команда владельца; агент не обходит ею ревью и лимит переоткрытий.

`needs_merge=true` требует непустой `scope`; `importance`/`urgency` — 0–3. Зависимости — `card dep`.

## Очередь и забег

После утверждения карточка встаёт в очередь задач по оценке. `now 3` показывает запросы и очередь; `now 1` — текущий забег и вероятные следующие, `now 2` — все забеги.

```bash
board run start --as developer --cards UI-1,UI-7   # или --suggest 1
board take UI-1 --as developer
board card step add UI-1 "Написать форму + тест"   # plan пишется при take
board finish UI-1 --as developer --summary "готово"
board run next --as developer
board run end --as developer [--review|--no-review]
```

`take` создаёт ветку `card/UI-1` и worktree `.worktrees/developer`; `finish` проверяет `scope` и мержит ветку в `dev` (`--no-ff`), затем ставит `review` или `done`. Если `runReview.mode != none`, `finish` отправляет в review все карточки забега, включая `review_required=false`. Если plan требует нового scope, `card edit` после approve не поможет: нужен `block`/`ask`, затем `card amend` и повторное утверждение.

Если нужен владелец — `block UI-1 --as developer --reason needs_decision --note "..."` или `ask UI-1 "вопрос" --as developer [--block]`. Ответ — `answer UI-1 "ответ"`.

## Ревью

`board review list --json` отдаёт карточки на ревью: spec, acceptance, plan/steps, scope и diff. `/spec-review` проверяет полноту spec до approve, `/review` проверяет plan и код:

```bash
board review submit UI-1 --plan done --verdict done --note "..." --reviewer review
board review finding UI-1 --severity critical --text "..."
```

`--plan` обязателен. `plan failed` требует `reopen`; `done` с findings разрешён. Ревью идёт одним циклом: findings становятся отдельными карточками, исходная карточка закрывается; `critical` блокирует `release`, `important`/`other` идут в backlog. Второй `reopen` — только решение владельца.

CLI субагентов не порождает — он готовит пакет и принимает вердикты. Finding-карточки после approve могут собраться в отдельный fix run. Субагент `board-reviewer` работает на default-варианте `reviewer.model`, не в Max; `self` использует модель основной сессии.

## Настройки

Настройки лежат в `.board/settings.json` и не попадают в git. Мастер
запускается один раз при первом `init`; позже его можно вызвать вручную
командой `/setup` или `board setup`.

```bash
board setup --show                                  # текущие настройки
board setup --spec-review auto|none|self|subagent   # проверка spec
board setup --large-spec 6000                       # порог большого spec
board setup --run-review none|self|subagent|auto    # run review: plan + код
board setup --reviewer-model provider/model         # default-вариант ревьюера
```

`specReview.mode=auto` (по умолчанию) выбирает субагента для Max/High или
большого spec, иначе self. `runReview.mode=none` по умолчанию. `self` — модель
основной сессии; `subagent` — `reviewer.model` без `#variant`. Флаги
`run end --review/--no-review` перекрывают настройку на один забег.

Старые `--review-after-run`/`--no-review-after-run` остаются алиасами
`runReview.mode=subagent|none`.

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
| `setup [--show\|--spec-review\|--large-spec\|--run-review\|--reviewer-model]` | настройки доски |
| `executor add\|list\|edit\|remove` | исполнители и навыки |
| `card add\|list\|show\|edit` | карточки |
| `card shape\|spec-review\|submit\|approve\|amend\|reject\|verdict\|done\|cancel\|reopen` | жизненный цикл |
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
| `review list\|finding\|submit --plan done\|failed` | пакет и вердикты ревью |
| `release` | слить `dev` в `main` |
| `now [0\|1\|2\|3]` | терминальная доска |
| `doctor` | диагностика |

Коды выхода: `0` — успех, `1` — делать нечего, `2` — нужно решение владельца, `3` — ошибка.

## OpenCode

`init` создаёт скилл `board`, плагин с инструментами `board_now`, `board_setup`, `board_card`, `board_run`, `board_take`, `board_finish`, `board_block`, `board_ask`, `board_answer`, `board_review`, `board_decision`, `board_term`, команды `/review`, `/spec-review`, `/setup` и read-only агент `board-reviewer` (если задан `reviewer.model`). Плагин не содержит логики: он вызывает `board … --json` и передаёт модели сессии `BOARD_MODEL_VARIANT`/`BOARD_SESSION_MODEL`. Файлы исполнителей-агентов настраиваются руками в `.opencode/agents/<id>.md`.
