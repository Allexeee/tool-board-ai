<!-- board:begin -->
## board

Доска карточек: локальный `tools/board/bin/board.ts`; `BOARD_CLI` — только отладочный override.

- Разговор ведёт brainstorming; spec и критерии приёмки пишутся в карточку, не в `docs/superpowers`.
- Читай `docs/board/terminology.md` в начале сессии и перед разбором; команды владельца авторитетны.
- Карточка: запрос → `card shape` (spec + критерии приёмки) → `card spec-review` → `card submit` → владелец `card approve`.
- После approve plan пишет исполнитель при `take`; plan — это steps + scope + проверки.
- Работа: `run start` → `take` (plan) → `finish --summary` → `run next` → `run end`; одиночный `take` без забега тоже работает.
- Исполнение Native: агент делает сам, без субагентов-исполнителей; план — steps карточки.
- `ask` — асинхронный вопрос; `block` — только если без ответа нельзя продолжать.
- Spec review — `/spec-review` (self или субагент), run review — `/review` (plan + код).
- Ревью идёт пакетом: ревьюер только читает, итоги прохода — `run note`. Первый проход полный; повторный — только дельта: исправлены ли находки и нет ли регрессий, новых он не ищет. Critical и регрессии чинятся сразу; important — finding-карточка в очередь; other — сборник в `deferred`.
- Ревьюеры-субагенты работают на default-варианте `reviewer.model`; режимы задаёт `/setup`.
- После `board init`, если в ответе `setupRequired: true`, спроси владельца и запусти `/setup`.
- Коммит делаешь сам в ветке карточки; мерж в `dev` делает `finish`. `main` меняется только `release` владельцем.
<!-- board:end -->
