---
name: board
description: Доска карточек: смотреть now, разбирать spec, брать забег, закрывать, ревьюить
---

# board

Доска карточек для владельца и агентов. Источник истины — база `.board/board.db`; язык проекта — `docs/board/terminology.md`.

## Начало сессии

Прочитай `docs/board/terminology.md`: термины и команды владельца. Используй их в общении с владельцем. Команды владельца авторитетны: если фраза не описана — спроси и предложи добавить её владельцу.

## Смотреть доску

`board now` (инструмент `board_now`): `now 0` — владельцу, `now 3` — открытые карточки, `now 1`/`now 2` — забеги.

## Карточка: spec и plan

1. Запрос → разбор: `board card shape <ID> --as <исполнитель> [--from card.json]`.
2. Если есть открытые вопросы — вытащи ответы у владельца (`ask`/`block`). Угадывать нельзя.
3. Заполни **spec** (`body`): problem/why, результат, non-goals, ограничения, зависимости, риски и **критерии приёмки** (`--acceptance` или `acceptance` в JSON). План (`steps`) при shape не пишется.
4. Spec review: `/spec-review`. Режим смотри в `board card show <ID> --json` → `specReview.mode`:
   - `none` — проверка не нужна;
   - `self` — проверь сам по чек-листу;
   - `subagent` — запусти `board-reviewer`.
5. Если spec неполный, сначала дополни его из контекста проекта, затем задай вопрос владельцу. Результат запиши: `board card spec-review <ID> --as <ревьюер> --mode self|subagent --verdict done|reopen --note "..."`.
6. `board card submit <ID> --as <исполнитель>`; владелец делает `card approve` или `card reject`.
7. После approve менять spec/acceptance/scope нельзя. Нужно изменение — `board card amend <ID> --as <исполнитель> --reason "..."`, затем снова review и approve.

## Забег и выполнение

1. `board run start --as <исполнитель> --cards <ID>,...` (или `--suggest 1`).
2. `board take <ID> --as <исполнитель>` — карточка в работе.
3. Перед кодом напиши **plan**: `board card step add <ID> "шаг + проверка"`, `card edit --scope ...`; каждый критерий приёмки должен быть отображён на шаг.
4. Если plan требует нового поведения или scope — остановись, `block`/`ask` владельцу; не меняй spec молча.
5. `board finish <ID> --as <исполнитель> --summary "..."` — сдать (review или done).
6. `board run next --as <исполнитель>` — следующая карточка.
7. `board run end --as <исполнитель> [--review|--no-review]` — закрыть забег. Если `reviewMode` не `none`, запусти `/review`.

## Если не можешь

- Решение владельца: `board block <ID> --as <исполнитель> --reason needs_decision --note "..."`.
- Вопрос: `board ask <ID> "вопрос" --as <исполнитель> [--block]`.

## Ревью

- `/spec-review` — полнота spec до approve. Может быть self или субагентом.
- `/review` — run review: соответствие plan и код; пакет — `board review list --json`. Субагент `board-reviewer` работает на default-варианте модели, не в Max.
- Findings: `board review finding <ID> --severity critical|important|other --text "..."`.
- Вердикт: `board review submit <ID> --plan done|failed --verdict done|reopen --note "..." --reviewer <id>`.
- `plan failed` требует `reopen`. `done` с findings разрешён: findings становятся карточками.
- Один цикл: findings не переоткрывают исходную карточку; `critical` блокирует release, `important`/`other` идут в backlog. Второй reopen — только владелец.
- Finding-карточки после approve могут собраться в отдельный fix run.

## Настройки

После установки плагина, если `board setup --show --json` вернул `setupAt: null`, спроси владельца и запусти `/setup`.

`board setup --show --json` — текущие настройки. Режимы:

- `board setup --spec-review auto|none|self|subagent`;
- `board setup --large-spec 6000`;
- `board setup --run-review none|self|subagent|auto`;
- `board setup --reviewer-model provider/model` (без `#variant`).

Если владелец не хочет менять настройку — ничего не выполняй.

## Решения и термины

- `board decision add [<ID>] "..." --kind decision|assumption --as <исполнитель>`.
- `board term add "термин" "значение" --as <исполнитель>`.
- Команды владельца (`board command list`) читай, не редактируй: их пишет только owner.

## Правила

- Работай в ветке карточки; коммит и мерж делает `board finish`. В `main` не пиши — его меняет `release` владельца.
- Причина обязательна у block/cancel/reject/reopen; `finish` требует `--summary`.
- Ревью своей карточки не давай: для кода вердикт — свежий субагент. Spec review может быть self по настройке.
- Один цикл ревью: не переоткрывай карточку из-за стилистических улучшений.
