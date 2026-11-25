<!-- board:begin -->
## board

Доска карточек: локальный `tools/board/bin/board.ts`; `BOARD_CLI` — только отладочный override.

- Разговор ведёт brainstorming; spec и критерии приёмки пишутся в карточку, не в `docs/superpowers`.
- Читай `docs/board/terminology.md` в начале сессии и перед разбором; команды владельца авторитетны.
- Карточка: запрос → `card shape` (spec + критерии приёмки) → `card spec-review` → `card submit` → владелец `card approve`.
- Решений владельца нет — `card submit --no-decisions`: карточка сразу в очередь, approve не нужен. Решения — окно выбора (2–4 варианта) и обычный `card approve`.
- Префикс — область проекта (Сайт, Контент, CORE), не ярлык задачи: сначала `board group list`, новый — только с `--new-group`; в пустом проекте — CARD.
- После approve plan пишет исполнитель при `take`; plan — это steps + scope + проверки.
- Работа: `run start` → `take` (plan) → `finish --summary` → `run next` → `run end`; одиночный `take` без забега тоже работает.
- «Открой/покажи бэклог» — `board backlog --open`; если доступен инструмент браузера, открой `docs/board/BACKLOG.html` в панели Review (`browser.preview`). В чат HTML не вставляй.
- Исполнение Native: агент делает сам, без субагентов-исполнителей; план — steps карточки.
- `writing-plans`, `executing-plans` и другие конкурирующие навыки superpowers в проекте выключены правами OpenCode: план — steps карточки, отдельного plan-файла нет.
- `ask` — асинхронный вопрос; `block` — только если без ответа нельзя продолжать.
- Spec review — `/spec-review` (self или субагент), run review — `/review` (plan + код).
- Ревью идёт пакетом: ревьюер только читает, итоги прохода — `run note`. Первый проход полный; повторный — только дельта: исправлены ли находки и нет ли регрессий, новых он не ищет. Critical и регрессии чинятся сразу; important — finding-карточка в очередь; other — сборник в `deferred`.
- Ревьюер не гоняет тесты и не пишет в доску; его shell ограничен read-only командами, каждая команда — отдельный вызов.
- Ревьюеры-субагенты работают на default-варианте `reviewer.model`; режимы задаёт `/setup`.
- После `board init` сразу покажи мастер окном выбора: «Оставить умолчания / Поменять / Не сейчас». Умолчания — `board setup --defaults`; недостающих исполнителей и области — `board executor add` / `board group add`.
- Коммит делаешь сам в ветке карточки; мерж в `dev` делает `finish`. `main` меняется только `release` владельцем.
<!-- board:end -->
