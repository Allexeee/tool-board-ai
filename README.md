# toolbox-al

Ящик инструментов для работы по фичам: очереди на исполнителей, где исполнитель — и человек, и ИИ-агент.

Требуется Node 26. Внешних зависимостей нет.

## Быстрый старт

```bash
node bin/toolbox-al.ts init            # скелет проекта
node bin/toolbox-al.ts executor add w1 --skills backend,frontend
node bin/toolbox-al.ts request add "Оплата подписки"
node bin/toolbox-al.ts feature add "Оплата" --request R1
node bin/toolbox-al.ts stage add F1 "Каркас" --goal "можно заплатить" --appetite "3 дня"
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
| `stage add\|list\|activate\|merge` | этапы: единица слияния и приёмки; `--appetite` обязателен |
| `feature start\|abandon` | ветка и рабочий каталог фичи; отмена без слияния |
| `save id --summary` | черновик в пределах области |
| `release major\|minor\|patch` | changelog, тег и слияние dev в main |
| `plan new\|show\|approve\|apply` | версии плана и атомарное создание работы |
| `idea add\|list\|promote` | идеи без обязательств |
| `decide add\|list` | журнал решений |
| `review id --as w2 --verdict ...` | вердикт по задаче |
| `stage accept\|reject` | приёмка этапа владельцем |
| `template save\|show\|list` | шаблоны разбиения |
| `similar "запрос"` | похожие прошлые фичи |
| `task add\|show\|list` | задачи; без DoD не создаются |
| `executor add\|list` | исполнители и их навыки |
| `hand show\|set\|add` | руки исполнителей |
| `next --as w1` | что делать дальше |
| `take [id] --as w1` | взять задачу в работу |
| `touch id --as w1` | продлить аренду |
| `done id --as w1 --summary "..."` | закрыть с отчётом |
| `block id --as w1 --reason ... --note "..."` | прервать с причиной |
| `reopen id --reason "..."` | вернуть в работу |
| `ask id "текст" --to owner` | задать вопрос |`n| `answer Q1 "ответ"` | ответить на вопрос |
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

## Рутины

```bash
node bin/toolbox-al.ts routine add "Деплой" --schedule "daily 02:00" --window 02:00-04:00
node bin/toolbox-al.ts routine step RU1 "Сборка" --action mechanical --cmd "npm run build"
node bin/toolbox-al.ts routine gate RU1 --kind approval --name first_publish --once
node bin/toolbox-al.ts gate approve G1
node bin/toolbox-al.ts tick
node bin/toolbox-al.ts cal --days 14
node bin/toolbox-al.ts friction
node bin/toolbox-al.ts scheduler enable --yes
```

Тикер по умолчанию выключен: без него рутины не идут, а `doctor` предупреждает.

## OpenCode

`init` создаёт:

- `.opencode/plugins/toolbox-al/index.ts` — инструменты `al_now`, `al_inbox`, `al_task`, `al_take`, `al_done`, `al_block`, `al_ask`, `al_answer` поверх CLI;
- `.opencode/skills/toolbox-al/SKILL.md` — как работать с очередью;
- `.opencode/skills/toolbox-al-setup/SKILL.md` — первичная настройка проекта;
- блок в `AGENTS.md` между маркерами.

Плагин не содержит логики: он вызывает `node bin/toolbox-al.ts … --json`. Если плагина нет, всё работает через CLI.

В OpenCode: «выполни первичную настройку toolbox-al», затем «разбери inbox».
