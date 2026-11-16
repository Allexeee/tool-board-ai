# toolbox-al

Ящик инструментов для работы по фичам: очереди на исполнителей, где исполнитель — и человек, и ИИ-агент.

Требуется Node 26. Внешних зависимостей нет.

## Установка

Клонировать один раз и положить в `PATH`:

```powershell
git clone https://github.com/Allexeee/toolbox-al.git "$env:USERPROFILE\tools\toolbox-al"
$env:Path += ";$env:USERPROFILE\tools\toolbox-al"
```

Дальше в любом проекте: `toolbox-al init`.

`npm install` из git **не работает**: Node отказывается обрабатывать TypeScript внутри `node_modules`. Запуск идёт из обычного каталога.

Если нужна фиксированная версия внутри проекта — git submodule:

```bash
git submodule add https://github.com/Allexeee/toolbox-al.git tools/toolbox-al
git -C tools/toolbox-al checkout v1.0.1
git add .gitmodules tools/toolbox-al
git commit -m "chore: pin toolbox-al 1.0.1"
```

Команды в проекте: `node tools/toolbox-al/bin/toolbox-al.ts …`. Плагин находит локальную копию сам — по пути `tools/toolbox-al/bin/toolbox-al.ts`. Переменная `TOOLBOX_AL_CLI` перекрывает всё, если нужен другой путь.

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

## Как читать идентификаторы и состояние

Идентификатор собирается из трёх уровней:

```
F1.S1-2  →  F1        фича №1
            .S1      этап №1
              -2     задача №2
```

- `R7` — запрос, то, что написал человек словами.
- `F1` — фича. `F1.S2` — её второй этап. `F1.S2-3` — третья задача второго этапа.
- `T3` — задача вне фичи (общий пул).
- `P2` — версия плана. `Q5` — вопрос. `I4` — идея. `D1` — решение.
- `RU2` — рутина, `RR5` — прогон рутины, `G3` — гейт.

Состояния задачи: `open` — создана, зависимости не закрыты; `ready` — зависимости закрыты, брать можно при активном этапе; `active` — в работе под арендой; `blocked` — прервана с причиной; `needs_owner` — нужен ответ владельца; `in_review` — сдана, ждёт вердикта; `done`, `cancelled`.

Состояния этапа: `planned` → `active` → `in_review` → `accepted` → `merged`. Состояния фичи: `approved` → `active` → `done`.

### `now`

```
1. F1  upgrade: обновление версии инструмента   [1/2]  done 1 · ready 3
```

Фича ранга 1, идёт этап 1 из 2, на нём закрыта одна задача и три готовы к взятию. Если бы задача была в работе, добавилось бы `active 1`.

### `dispatch`

```
worker-all   F1.S1-2, F1.S1-3, F1.S1-4   → F1.S1-2
```

Слева — рука: задачи, зарезервированные за исполнителем, в порядке взятия. После стрелки — та, которую он возьмёт следующей. Рука может быть неполной; это план, а не загрузка.

### `task list F1.S1`

```
F1.S1-1  done   Добавить команду version
F1.S1-2  ready  Проверка доступных версий через git и каталог
```

Порядок строк — порядок этапа, а не приоритет. Внутри руки приоритет задаёт класс обслуживания, затем размер, затем id.

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
