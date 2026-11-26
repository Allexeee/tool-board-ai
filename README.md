# tool-board-ai

Доска карточек для владельца и ИИ-агентов. Одна сущность — карточка: сначала запрос, после разбора и утверждения — задача. Карточки берутся в забеги, выполняются, сдаются на ревью и заливаются в `main`.

Требуется Node 24 или новее: встроенный `node:sqlite` и запуск TypeScript без сборки. Внешних зависимостей нет.

## Установка

Глобально нужен только установщик board. В каждом git-проекте `board init`
добавляет свою версию в `tools/board` (git submodule), и дальше проект
работает только с ней.

```powershell
# скопируйте/клонируйте этот репозиторий (ветку с доской) в удобное место
git clone https://github.com/Allexeee/tool-board-ai.git "$env:USERPROFILE\tools\tool-board-ai"
$env:Path += ";$env:USERPROFILE\tools\tool-board-ai"
```

В корне лежит `board.cmd`; он запускает `node bin\board.ts`. Проверка
глобального установщика: `board --version`.

В проекте с `tools/board` глобальный `board` — тонкий диспетчер: он передаёт
команду локальному `tools/board/bin/board.ts`, поэтому `board --version`
показывает версию проекта, а не установщика. Без локального CLI работают
только `init`, `doctor`, `--version`, `help`; операционные команды просят
`board init`.

`BOARD_CLI` — только отладочный override, когда локального CLI нет. Локальный
`tools/board` всегда важнее.

## Своя версия board

```bash
board init --board-version v1.2.0   # добавить submodule или переключить его
board upgrade v1.3.0                # переключить и перегенерировать .opencode
board upgrade --latest              # последний тег источника
board init --refresh                # перегенерировать из текущей версии
board --global --version            # обойти локальный CLI (ремонт, отладка)
```

`board init` без `--board-version` ставит последний тег источника. Указатель
submodule коммитится вместе с `.gitmodules` и `.opencode`. CI-клону нужен
`git submodule update --init` (или `--recurse-submodules`).

Даунгрейд на более старую версию требует `--allow-downgrade`: схема базы
мигрирует только вперёд, поэтому сначала сделайте бэкап `.board/board.db`.

`upgrade` и `init --refresh` печатают блок «Что нового для вас» и отдают его в
`--json` полями `from`, `to`, `whatsNew`. Заметки релиза лежат в
`docs/whats-new/<version>.md`: 3–5 пунктов списка без флагов и CLI-жаргона.
Повторный `init --refresh` не повторяет уже показанное; если изменений нет,
печатается понятное сообщение. После обновления агент пересказывает блок
человеческим языком и предлагает `board adopt --check`.

### План обновления adopt

```bash
board adopt --check       # план по проекту, ничего не создаёт
```

`adopt` смотрит, чего не хватает проекту: областей, словаря тегов, профиля
ревью (`auto` с эффективным профилем текущей модели), правил приёмки,
исполнителей, бэклога и задач в `docs/inbox` и файлах-чеклистах. Доска только
показывает план и готовые команды; создаёт всё агент после согласия владельца
обычными `group add`, `tag add`, `setup --profile`, `acceptance rule add`,
`executor add` и `card add`. Повторный `--check` идемпотентен и показывает
остаток, дублей нет.

## Установка в существующий проект

Старый `toolbox-al` или `.toolbox-al` в проекте не нужен. `init` создаёт
новую доску с нуля и не переносит старые данные.

В корне существующего проекта:

```bash
git checkout -b dev          # если ветки dev ещё нет
board init                   # добавит tools/board (submodule) и .opencode
git add -A                   # .gitmodules, tools/board, .opencode
git commit -m "chore: board init"
board setup --defaults       # бэклог, ревью, исполнитель developer
board group add SITE --name Сайт
board backlog --open         # показать бэклог в браузере
board doctor
board now
```

`init` в любом режиме печатает предложение мастера: бэклог, ревью, исполнитель
`developer`, области. Агент показывает его окном выбора «Оставить умолчания /
Поменять / Не сейчас». `board setup --defaults` применяет умолчания разом;
`/setup` и флаги `board setup` меняют отдельные настройки.

Области можно переименовать или слить: `board group rename OLD NEW [--merge] [--dry-run]`.
Переносятся карточки и все ссылки; старые ID остаются в `legacy_ids`, `card show` по ним работает.
Карточки в `in_progress`/`booked`/`shaping` сначала закрываются.

`init` создаёт:

- `.board/board.db` — базу (истина доски) и исполнителя `owner`;
- `.board/settings.json` — локальные настройки (в git не попадает);
- `docs/board/terminology.md` — термины и команды владельца;
- `.opencode/skills/board-spec|board-work|board-run|board-now/SKILL.md`, `.opencode/plugins/board/index.ts`,
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

Команда перезапишет четыре навыка в `.opencode/skills/`, плагин и команды
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

`needs_merge=true` по умолчанию включает ревью (`review_required`). Отказ — только владелец: `--no-review --reason "..." --as owner`, пишется событие `card.review_waived`. `release` блокируется, если в dev и не в main есть done без вердикта `done`, waiver или покрытия пакетным проходом (кроме профиля `low`).

Профиль ревью: `board setup --profile auto|low|default|high|max|custom`. `auto` берёт профиль по варианту модели (`low/default/high/max`). Встроенные: `low` — spec self, run none, без пакетного ревью и реревью; `default` — spec auto 500 слов, run auto, реревью 1; `high` — spec auto 250 слов, run subagent, реревью 2, important чинятся сразу; `max` — spec subagent, run subagent, реревью 3, каждая карточка в ревью. Свои профили — `review.profiles` в `.board/settings.json`; старые флаги `--spec-review`/`--run-review` переключают на `custom`.

## Очередь и забег

После утверждения карточка встаёт в очередь задач по оценке. `now 0` (по умолчанию) показывает владельцу утверждения, owner-задачи и вопросы; `now 1` — задачи указанного `--as`; `now 2` — других агентов; `now 3` — открытые запросы и очередь.

```bash
board run start --as developer --cards UI-1,UI-7   # или --suggest 1
board take UI-1 --as developer
board card step add UI-1 "Написать форму + тест"   # plan пишется при take
board card scope add UI-1 src/extra.ts --as developer  # новый файл в работе
board finish UI-1 --as developer --summary "готово"
board run next --as developer
board run end --as developer [--review|--no-review]
board run note RUN-1 --text "итоги прохода" --as reviewer
```

`take` создаёт ветку `card/UI-1` и worktree `.worktrees/developer`; `finish` проверяет `scope` и мержит ветку в `dev` (`--no-ff`), затем ставит `review` или `done`. Если `runReview.mode != none`, `finish` отправляет в review все карточки забега, включая `review_required=false`. Если plan требует нового файла, `card scope add` расширяет scope у карточки в работе; если нового поведения или acceptance — `block`/`ask`, затем `card amend` и повторное утверждение.

Если нужен владелец — `block UI-1 --as developer --reason needs_decision --note "..."` или `ask UI-1 "вопрос" --as developer [--block]`. Ответ — `answer UI-1 "ответ"`.

## Ревью

`board review list --json` отдаёт пакет: карточки в `review` с spec, acceptance, plan, scope и **командой** `git diff <merge>^1 <merge>` — сам diff нужно выполнить. `/spec-review` проверяет полноту spec до approve, `/review` — проход по пакету:

```bash
board run note RUN-1 --text "ИТОГИ: покрытые карточки, вердикты, находки" --as reviewer
board review submit UI-1 --plan done --verdict done --note "итоги: RUN-1" --reviewer reviewer
board card ref add UI-1 --kind review --value RUN-1 --title "итоги прохода"
```

Ревьюер только читает: карточек не создаёт. Итоги прохода — `run note` (или `review submit --note` для одиночной карточки), в карточке — вердикт и ссылка. Бюджет прохода: первый проход полный; повторный — только дельта (исправлены ли находки и нет ли регрессий от фикса), новых он не ищет. Critical и регрессии чинятся сразу; important — finding-карточка в очередь и не блокирует релиз; other — сборник `review notes` в `deferred`. Больше 7 находок на проход не перечисляют.

Перед релизом — пакетный проход по done-карточкам dev вне main:

```bash
board review package                       # состав: ID, заголовок, merge-коммит
board review package --since <ref>         # другая база вместо main
board review package --verdict done --reviewer reviewer --note "ИТОГИ: ..."
```

Проход пишется одной записью `review.package`: карточки, коммиты, вердикт, находки. Пакет собирает карточки, чьи коммиты ещё не покрыты проходом с `done`; `release` требует, чтобы все коммиты релиза были покрыты. Отказ владельца — `release --no-review --reason "..."` с событием `release.review_waived`.

CLI субагентов не порождает — он готовит пакет и принимает вердикты. Субагент `board-reviewer` работает на default-варианте `reviewer.model`, не в Max; `self` использует модель основной сессии.

## Идеи

Идея — карточка группы `IDEA`: статус `deferred`, тег `idea`, без мержа, ревью и очереди.

```bash
board idea add "Тёмная тема" [--title "..."]
board idea list
board idea edit IDEA-1 --text "..." --title "..."
board idea drop IDEA-1
```

В бэклоге идеи идут отдельной таблицей «Идеи» в конце; в задачи, отложенные и готовые они не попадают. В плагине — `board_idea`.

## Приёмка владельцем

Флаг `owner_acceptance` означает, что результат должен посмотреть владелец. Сданная карточка с флагом встаёт в статус `acceptance`; после код-ревью — тоже туда, а не в `done`. Релиз ждёт обе проверки: ревью и приёмку.

```bash
board acceptance rule add visual --include-tag ui --include-path "src/components/**" --exclude-tag no-acceptance
board acceptance rule list
board acceptance check CORE-1
board card accept CORE-1 [--note "..."]
board card accept CORE-1 --reject --reason "кнопка не та" --as owner
```

Правила живут в `acceptance.rules`: `include`/`exclude` по группам, тегам, навыкам и путям; общий `exclude` снимает приёмку. Проверка идёт по заявленному scope и фактическому diff на `finish`. Явный `--owner-acceptance` / `--no-owner-acceptance` сильнее правил. В бэклоге карточки приёмки — в начале «Задачи для владельца»; в `now` — счётчик и пометка «ждёт приёмки».

## Настройки

Настройки лежат в `.board/settings.json` и не попадают в git. Мастер
запускается один раз при первом `init`; позже его можно вызвать вручную
командой `/setup` или `board setup`.

```bash
board setup --show                                  # текущие настройки
board setup --spec-review auto|none|self|subagent   # проверка spec
board setup --large-spec 6000                       # порог большого spec
board setup --max-spec 1500                         # порог для max-модели
board setup --run-review none|self|subagent|auto    # run review: plan + код
board setup --reviewer-model provider/model         # default-вариант ревьюера
board setup --backlog-path docs/board/BACKLOG.md    # путь md-бэклога
board setup --backlog-refresh 5                     # автообновление HTML, сек (0 — выкл.)
```

`specReview.mode=auto` (по умолчанию) выбирает субагента по длине spec:
для варианта `max` — порог `maxSpecChars` (1500), для `high` и остальных —
`largeSpecChars` (6000); ниже порога — self. `runReview.mode=none` по
умолчанию. `self` — модель
основной сессии; `subagent` — `reviewer.model` без `#variant`. Флаги
`run end --review/--no-review` перекрывают настройку на один забег.

Старые `--review-after-run`/`--no-review-after-run` остаются алиасами
`runReview.mode=subagent|none`.

## Границы продукта

Доска — **local-only**: одна машина, один владелец. База `.board/board.db` живёт локально и не шарится; `--as owner` — маркер в журнале, а не аутентификация; ограничения ревьюера держатся на правах harness, а не на песочнице.

Чего здесь нет и не планируется: синхронизации базы между машинами, ролей и доступа для команды, сервера. Копию базы для доступа с другого ПК держите в приватном git-репозитории (`sync push/pull`) или в облачной папке; публичный репозиторий проекта для данных не годится.

Командный режим — общая база, аутентификация вместо `--as`, роли — отдельный проект.

## Релиз

`release` — команда владельца: проверяет, что в `dev` нет незавершённых карточек и открытых `critical`-находок, и мержит `dev` в `main` (`--no-ff`).

Версия проекта — semver: major — ломающие изменения, minor — новые возможности, patch — исправления, документация и внутренние правки. `board bump patch|minor|major` обновляет `package.json`, lock и CHANGELOG; `release` требует версию новее последнего тега.

```bash
board bump minor
board release
board release --package developer   # только карточки навыков исполнителя
board release --package content     # или навык, если исполнителя с таким id нет
```

`--package` собирает временную ветку от `main`, переносит в неё только merge-коммиты выбранных карточек (`cherry-pick -m 1`) и мержит в `main`. Невыбранные изменения остаются в `dev`; `in_main` и тег отражают только пакет. При конфликте релиз откатывается, `main` не меняется. Гейты ревью и находок считаются по выбранному набору.

## Доска

```bash
board now      # вкладка 0: задачи для меня
board now 0    # владельцу: утверждения, owner-задачи ready/waiting, вопросы
board now 1    # задачи текущего --as: на руках, очередь, вероятные забеги
board now 2    # задачи других агентов
board now 3    # открытые запросы и общая очередь
```

`now 0` — по умолчанию: утверждения, owner-задачи в `ready`/`waiting` и открытые вопросы; имя исполнителя в строках не печатается. `now 1` показывает задачи текущего `--as` на руках и в очереди, а также три вероятных забега по тегам: «НОВОЕ», «УЛУЧШЕНИЕ», «ПОСЛЕ РЕВЬЮ». Запрос в забеге помечен `?`; каждая карточка — отдельная строка. `now 2` показывает только других агентов, без текущего и без забегов. `now 3` — открытые запросы и общая очередь; отменённые и закрытые не попадают.

Теги — реестр: `board tag add|list|rename|remove`. На `card shape --tag` теги берутся из дизайна задачи, `card tag add|remove|list` меняют точечно; `card edit --tag` заменяет список, `--clear-tags` очищает. Находки ревью получают `review`, идеи — `idea`. Карточка без вариантного тега в вероятные забеги не попадает — `now 1` показывает счётчик «БЕЗ ТЕГА».

Запрос может входить в забег: `run start --cards` принимает его как `planned`, `run next` возвращает первым, `take` сначала переводит в разбор, а повторный `take` после spec — в работу с веткой и lease. Approve владельца для такого запроса не требуется; spec показывается, забег можно остановить. Цвета статусов, имён агентов и маркера `?` включаются только в живом терминале: в `--json`, пайпе и при `NO_COLOR` ANSI нет.

Фильтры `now 3`: `--group UI`, `--skill dev`, `--status ready,waiting`, `--mine`, `--phase request`, `--limit`, `--all`; в `now 1/2` — `--group` и `--skill`. Все команды принимают `--json`.

## Superpowers

Superpowers — локальная настройка пользователя, а не часть проекта. Проект не
коммитит `.opencode/opencode.json` и не задаёт путь к пакету; каждая машина
решает сама, включать ли его.

Остальные глобальные скиллы (`frontend-design`, `ui-ux-pro-max`, `unity-2022`)
продолжают работать.

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
| `init [каталог] [--yes] [--refresh] [--board-version <ref>] [--board-source <url>]` | скелет проекта, submodule `tools/board`, мастер настроек и обновление `.opencode` |
| `upgrade <ref>\|--latest [--allow-downgrade]` | переключить `tools/board` и перегенерировать `.opencode` |
| `adopt --check` | план обновления проекта: области, теги, профиль, приёмка, исполнители, бэклог и задачи; ничего не создаёт |
| `setup [--show\|--spec-review\|--max-spec\|--large-spec\|--run-review\|--reviewer-model]` | настройки доски |
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
| `backup [path]` | копия `.board/board.db` |
| `export [--format json\|md] [--out path]` | выгрузка карточек |
| `backlog [--out path] [--html]` | md- или HTML-бэклог (HTML сам перезагружается) |
| `now [0\|1\|2\|3]` | терминальная доска |
| `doctor` | диагностика |

Коды выхода: `0` — успех, `1` — делать нечего, `2` — нужно решение владельца, `3` — ошибка.

## OpenCode

`init` создаёт скилл `board`, плагин с инструментами `board_now`, `board_setup`, `board_card`, `board_run`, `board_take`, `board_finish`, `board_block`, `board_ask`, `board_answer`, `board_review`, `board_decision`, `board_term`, `board_queue`, `board_touch`, `board_doctor`, `board_backup`, `board_release`, команды `/review`, `/spec-review`, `/setup` и read-only агент `board-reviewer` (если задан `reviewer.model`). Плагин не содержит логики: он вызывает `board … --json`, отдаёт записи компактно (`id`, `status`, `branch`, `position`; списки и `now` — строками) и передаёт модели сессии `BOARD_MODEL_VARIANT`/`BOARD_SESSION_MODEL`. Файлы исполнителей-агентов настраиваются руками в `.opencode/agents/<id>.md`.
