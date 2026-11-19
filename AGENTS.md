<!-- board:begin -->
## board

Доска карточек: `node bin/board.ts`.

- Читай `docs/board/terminology.md` в начале сессии и перед разбором; команды владельца авторитетны.
- Карточка: запрос → `card shape` → `card submit` → владелец `card approve`/`card reject`.
- Работа: `run start` → `take` → `finish --summary` → `run next` → `run end`.
- Нужно решение владельца — `block`/`ask`; карточка ждёт.
- Ревью — свежий субагент командой `/review`; CLI субагентов не порождает.
- Коммит и мерж делает `finish`; агент в git не пишет. `main` меняется только `release` владельцем.
<!-- board:end -->
