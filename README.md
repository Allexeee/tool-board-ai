# toolbox-al

Ящик инструментов для работы по фичам: очереди на исполнителей, где исполнитель — и человек, и ИИ-агент.

Требуется Node 26. Внешних зависимостей нет.

## Быстрый старт

```bash
node bin/toolbox-al.ts init            # скелет проекта
node bin/toolbox-al.ts executor add w1 --skills backend,frontend
node bin/toolbox-al.ts request add "Оплата подписки"
node bin/toolbox-al.ts feature add "Оплата" --request R1
node bin/toolbox-al.ts stage add F1 "Каркас" --goal "можно заплатить"
node bin/toolbox-al.ts stage activate F1
node bin/toolbox-al.ts task add F1.S1 "Добавить вебхук подтверждения" \
  --dod "вебхук принимает событие" --size S --skill backend \
  --class standard --scope "src/billing/**"
node bin/toolbox-al.ts now
node bin/toolbox-al.ts take F1.S1-1 --as w1
node bin/toolbox-al.ts done F1.S1-1 --as w1 --summary "вебхук работает" --checks "npm test"
```

## Команды

| Команда | Что делает |
|---|---|
| `init [каталог]` | создаёт `.toolbox-al/`, базу, `.gitignore` |
| `request add\|list\|show` | запросы: то, что пишет человек словами |
| `feature add\|list\|show\|rank` | фичи и их ранг |
| `stage add\|list\|activate` | этапы: единица слияния и приёмки |
| `task add\|show\|list` | задачи; без DoD не создаются |
| `executor add\|list` | исполнители и их навыки |
| `hand show\|set\|add` | руки исполнителей |
| `next --as w1` | что делать дальше |
| `take [id] --as w1` | взять задачу в работу |
| `touch id --as w1` | продлить аренду |
| `done id --as w1 --summary "..."` | закрыть с отчётом |
| `block id --as w1 --reason ... --note "..."` | прервать с причиной |
| `reopen id --reason "..."` | вернуть в работу |
| `ask id "текст" --to owner` | задать вопрос |
| `now` | фичи, этапы, кто что держит |
| `inbox` | что ждёт человека |
| `dispatch` | кому какая задача достаётся |
| `doctor` | проверка настройки |

Все команды принимают `--json` и возвращают `0` при успехе, `1` когда делать нечего, `2` когда нужно решение владельца, `3` при ошибке.

## Правила, которые проверяет код

- Задача без DoD, размера, навыка и области файлов не создаётся.
- Размер `XL` отвергается: это фича, а не шаг.
- Циклы зависимостей отвергаются с путём цикла.
- Двое не берут одну задачу: захват атомарный.
- Аренда истекает сама; третья неудача уходит владельцу.
- `expedite` выдаётся первым, лимит — один активный на исполнителя.
- Порядок детерминирован: два `dispatch` дают одно и то же.
