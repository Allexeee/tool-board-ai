<!-- board:begin -->
## board

Доска карточек: локальный `tools/board/bin/board.ts`; `BOARD_CLI` — только отладочный override.

- Читай `docs/board/terminology.md` в начале сессии и перед разбором; команды владельца авторитетны.
- Карточка: запрос → `card shape` (spec + критерии приёмки) → `card spec-review` → `card submit` → владелец `card approve`.
- После approve plan пишет исполнитель при `take`; plan — это steps + scope + проверки.
- Работа: `run start` → `take` (plan) → `finish --summary` → `run next` → `run end`.
- Нужно решение владельца — `block`/`ask`; карточка ждёт.
- Spec review — `/spec-review` (self или субагент), run review — `/review` (plan + код).
- Ревью идёт одним циклом: findings становятся карточками; critical блокирует release, important/other — backlog.
- Ревьюеры-субагенты работают на default-варианте `reviewer.model`; режимы задаёт `/setup`.
- После `board init`, если в ответе `setupRequired: true`, спроси владельца и запусти `/setup`.
- Коммит и мерж делает `finish`; агент в git не пишет. `main` меняется только `release` владельцем.
<!-- board:end -->
