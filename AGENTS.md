<!-- board:begin -->
## board

Доска карточек: `board` (если CLI в PATH); в плагине OpenCode — `BOARD_CLI`.

- Читай `docs/board/terminology.md` в начале сессии и перед разбором; команды владельца авторитетны.
- Карточка: запрос → `card shape` → `card submit` → владелец `card approve`/`card reject`.
- Работа: `run start` → `take` → `finish --summary` → `run next` → `run end`.
- Нужно решение владельца — `block`/`ask`; карточка ждёт.
- Ревью — свежий субагент командой `/review`; CLI субагентов не порождает.
- Ревью после каждого забега — настройка `/setup` (по умолчанию выкл.); если `run end` вернул `review=true`, запусти `/review`.
- Коммит и мерж делает `finish`; агент в git не пишет. `main` меняется только `release` владельцем.
<!-- board:end -->
