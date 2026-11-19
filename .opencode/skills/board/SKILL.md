---
name: board
description: Доска карточек: смотреть now, разбирать, брать забег, закрывать, ревьюить
---

# board

Доска карточек для владельца и агентов. Источник истины — база `.board/board.db`; язык проекта — `docs/board/terminology.md`.

## Начало сессии

Прочитай `docs/board/terminology.md`: термины и команды владельца. Используй их в общении с владельцем. Команды владельца авторитетны: если фраза не описана — спроси и предложи добавить её владельцу.

## Смотреть доску

`board now` (инструмент `board_now`): `now 0` — владельцу, `now 3` — открытые карточки, `now 1`/`now 2` — забеги.

## Жизненный цикл карточки

1. Запрос → разбор: `board card shape <ID> --as <исполнитель> [--from card.json]`. Заполни body, шаги, навык, importance/urgency, needs_merge, review_required, scope, зависимости.
2. На утверждение: `board card submit <ID> --as <исполнитель>`.
3. Владелец: `board card approve <ID>` или `board card reject <ID> --reason "..."`.

## Забег и выполнение

1. `board run start --as <исполнитель> --cards <ID>,...` (или `--suggest 1`).
2. `board take <ID> --as <исполнитель>` — карточка в работе.
3. Работаешь.
4. `board finish <ID> --as <исполнитель> --summary "..."` — сдать (review или done).
5. `board run next --as <исполнитель>` — следующая карточка.
6. `board run end --as <исполнитель> [--review]` — закрыть забег.

## Если не можешь

- Решение владельца: `board block <ID> --as <исполнитель> --reason needs_decision --note "..."`.
- Вопрос: `board ask <ID> "вопрос" --as <исполнитель> [--block]`.

## Ревью

`board review list --json` — карточки на ревью. Свежий субагент проверяет и выносит вердикт:

`board review submit <ID> --verdict done|reopen --note "..." --reviewer <id>`.

Находки: `board review finding <ID> --severity critical|important|other --text "..."`.

## Решения и термины

- `board decision add [<ID>] "..." --kind decision|assumption --as <исполнитель>`.
- `board term add "термин" "значение" --as <исполнитель>`.
- Команды владельца (`board command list`) читай, не редактируй: их пишет только owner.

## Правила

- Работай в ветке карточки; коммит и мерж делает `board finish`. В `main` не пиши — его меняет `release` владельца.
- Причина обязательна у block/cancel/reject/reopen; `finish` требует `--summary`.
- Ревью своей карточки не давай: вердикт — свежий субагент.
