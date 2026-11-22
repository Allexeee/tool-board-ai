---
name: board-work
description: Доска: исполнить карточку — take, план в steps, TDD, finish, отчёт
---

# board-work

## Исполнение

Всегда Native: агент исполняет карточку сам. Субагенты не используются для реализации, builder-check и написания spec/plan. TDD и проверки — по шагам; план живёт в steps карточки, отдельного plan-файла нет.

## Работа

1. `board take <ID> --as <исполнитель>` — карточка в работе. Для запроса первый `take` переводит его в разбор, второй — в работу.
2. Перед кодом напиши **plan**: `board card step add <ID> "шаг + проверка"`; scope зафиксирован в spec.
3. Если plan требует нового поведения или scope — остановись: `amend` или вопрос владельцу.
4. `board finish <ID> --as <исполнитель> --summary "..."` — сдать (review или done).
5. `board run next --as <исполнитель>` — следующая карточка забега.

## Отчёт

Одно сообщение на событие, не на команду; spec не пересказывать, сроки не обещать, о каждом вызове инструмента не отчитываться.

- разбор закончен — «Разобрал X: …» и «Вопросов нет» либо список вопросов;
- второй `take` — «Приступаю к X: шаги 1..N»;
- `finish` — «Сдал X: что сделано, тесты, коммит»;
- `block` или `drop` — «Снял X: причина, создал Y».

## Ревью

- `/spec-review` — полнота spec до approve; self или субагент по настройке.
- `/review` — run review: соответствие plan и код; пакет — `board review list --json`. Субагент `board-reviewer` работает на default-варианте модели.
- Findings: `board review finding <ID> --severity critical|important|other --text "..."`.
- Вердикт: `board review submit <ID> --plan done|failed --verdict done|reopen --note "..." --reviewer <id>`.
- Один цикл: findings не переоткрывают исходную карточку; `critical` блокирует release, `important`/`other` идут в backlog. Второй reopen — только владелец. Свою карточку не ревьюй: для кода вердикт даёт свежий субагент.

## Правила

- Работай в ветке карточки: коммит делаешь сам, мерж в `dev` делает `board finish`. В `main` не пиши — его меняет `release` владельца.
- Причина обязательна у block/cancel/reject/reopen; `finish` требует `--summary`.
- `card reopen` — только владелец; агент не обходит ею ревью и лимит переоткрытий.
