---
name: board-spec
description: Доска: разобрать запрос в spec и утвердить — критерии приёмки, вопросы, reviewRequired
---

# board-spec

Доска карточек: источник истины — `.board/board.db`; термины и команды владельца — `docs/board/terminology.md`. Они авторитетны: если фразы нет в списке — спроси владельца и предложи её добавить.

## Разговор и брейншторм

Разговор ведёт brainstorming, а не этот навык. В board-проекте brainstorming не пишет `docs/superpowers/**`: spec и критерии приёмки идут в карточку (`card shape`), решения — в body карточки или `board decision`, утверждение дизайна — `card approve`. Второго гейта (отдельного design doc) нет.

Доска реагирует только на глагол работы: «разбери / добавь / оформи» — карточка и навык board-spec, «работай» — board-work, «Ран» — board-run. Без глагола работы карточки не создаются: на «порассуждать» доска молчит.

## Разбор

1. Запрос → разбор: `board card shape <ID> --as <исполнитель> [--from card.json]`.
2. Вопросы по разбору решай в чате. `ask` — асинхронный вопрос, если владельца нет; `block` — только если без ответа нельзя продолжать. Угадывать нельзя.
3. Заполни **spec** (`body`): problem/why, результат, non-goals, ограничения, зависимости, риски и **критерии приёмки**. План (`steps`) при shape не пишется.
4. Spec review: `/spec-review`. Режим — `board card show <ID> --json` → `specReview.mode`: `none` — не нужна, `self` — сам, `subagent` — `board-reviewer`. Результат: `board card spec-review <ID> --mode self|subagent --verdict done|reopen --note "..."`.
5. `board card submit <ID> --as <исполнитель>`; владелец делает `card approve` или `card reject`.
6. После approve spec/acceptance/scope не меняются. Нужно изменение — `board card amend <ID> --reason "..."`, затем review и approve снова.

## Просто или не просто

- **Просто**: нового поведения нет, одна область, критерий проверяется глазами → `reviewRequired=false`, отдельный забег не нужен.
- **Не просто**: новое поведение или решение → `reviewRequired=true`, карточка идёт в забег.
- Уточнение владельца «тут перекрась» относится к текущей карточке: шаг в плане или `card amend`. Отдельная мелкая карточка добавляется в текущий забег владельцем или берётся без забега.

## Решения и термины

- `board decision add [<ID>] "..." --kind decision|assumption --as <исполнитель>`.
- `board term add "термин" "значение" --as <исполнитель>`.
- Команды владельца (`board command list`) читай, не редактируй: их пишет только owner.
