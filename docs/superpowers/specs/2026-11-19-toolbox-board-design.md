# toolbox-al v2: доска карточек — дизайн

**Дата:** 2026-11-19
**Статус:** черновик на утверждение
**Рабочее имя CLI:** `board` (пакет `toolbox-al`, имя можно поменять)

## 1. Зачем

Нужна публичная доска для людей и ИИ-агентов. Владелец пишет, что хочет получить.
Любой исполнитель может разобрать запрос, разложить его на шаги, создать новые
карточки и выставить оценку. Дальше карточки берут в забеги, выполняют, сдают на
ревью и заливают в `main`.

Текущий `toolbox-al` умеет это и ещё двадцать вещей: фичи, этапы, планы,
рутины, календарь, гейты, релизы, прогоны, профилировщик, идеи, шаблоны,
похожие фичи, карту модулей. Модель из четырёх уровней и сорока команд мешает
пользоваться ядром. Этот документ описывает переписывание инструмента вокруг
одной сущности — карточки.

### Что остаётся

- очередь запросов и очередь задач;
- карточка как задача с шагами;
- забеги (runs) и бронирование;
- ревью;
- журнал решений и допущений;
- терминальная доска `now`;
- git-интеграция варианта B (см. § 7).

### Что убирается

- `features`, `stages`, `plans` как отдельные сущности и `apply`;
- `routines`, `calendar`, `gates`, `tick`, `schedule`;
- `ideas`, `templates`, `similar`, старые `decisions`;
- `power`, `profiler`, `usage`, `memory`, `handoff`, `digest`, `friction`, `week`;
- старый пул, руки, аренды и `preempt` (заменяются забегами и lease);
- `map`, `upgrade`, `release` со changelog и тегами (остаётся минимальный release);
- ветки и worktree на фичу/этап (заменяются веткой на карточку);
- старые прогоны с режимами и питанием;
- многоуровневые ID `F1.S1-2`.

## 2. Цели, не-цели, анти-цели

### Цели

- Одна сущность — карточка; запрос и задача — её фазы.
- Человекочитаемые ID `<группа>-<номер>`.
- Один требуемый навык у карточки; агент не берёт чужое.
- Зависимости между карточками, без иерархии.
- Явные статусы «ждёт» и «в процессе».
- Очередь с оценкой важности/срочности и ручной перестановкой.
- Забег из нескольких карточек с атомарным бронированием.
- Ревью пакетом, свежим субагентом.
- Точный ответ, что в `dev` и что в `main`.
- Терминальная доска с вкладками.
- Один общий `docs/board/decisions.md`.
- База — источник истины, md — журнал.

### Не-цели v1

- Веб-интерфейс и сервер для разных машин. Пока один репозиторий на одной машине,
  локальный SQLite и CLI.
- Авто-ран. Обсудим отдельно; в v1 его нет.
- Миграция старых баз `.toolbox-al`. Новая база создаётся с нуля.
- Иерархия карточек, эпики, этапы, релизные поезда.
- Автоматическое разрешение git-конфликтов.
- Управление OpenCode-агентами (генерация файлов агентов) — настраиваются руками.

### Анти-цели

- Тулбокс не должен быть git-сервером: он создаёт изоляцию, мержит карточку в
  `dev` и проверяет состояние, но не решает содержательные конфликты.
- Ревью не должно останавливать весь конвейер: карточка в `review` уже в `dev`,
  зависимости открыты.
- Непроверенное не должно попадать в `main`: `release` блокируется, пока в `dev`
  есть незавершённые карточки.
- md не должен быть вторым источником истины: ручные правки в нём не команда.

## 3. Модель

### 3.1 Карточка

Одна сущность. Пока карточка не разобрана — это запрос (`phase=request`).
После разбора и утверждения — задача (`phase=task`) с чек-листом шагов.

| Поле | Смысл |
|---|---|
| `id` | `<group>-<n>`, например `UI-1`; выдаётся атомарно |
| `group` | префикс группы: `UI`, `IM`, `OPS` |
| `title` | короткое название |
| `body` | Markdown: что хочу, ссылки, документация, ограничения |
| `phase` | `request` или `task` |
| `status` | см. § 4 |
| `skill` | требуемый навык; для owner-карточек `owner` |
| `importance` | 1–5, ставит разбирающий |
| `urgency` | 1–5, ставит разбирающий |
| `position` | место в очереди задач; у запросов пусто |
| `needs_merge` | нужен ли git-мерж |
| `review_required` | нужен ли ревью-вердикт |
| `scope` | JSON-массив glob-путей, за которые нельзя выходить |
| `holder` | кто держит карточку сейчас |
| `run_id` | текущий забег |
| `branch` | ветка карточки, `card/UI-1` |
| `merge_commit` | последний merge-коммит в `dev` |
| `in_dev` | merge-коммит является предком `dev` |
| `in_main` | merge-коммит является предком `main` |
| `lease_until` | срок брони/разбора; продлевается `touch` |
| `previous_holder` | кто держал до переоткрытия/отказа ревью |
| `created_at`, `updated_at`, `shaped_at`, `approved_at`, `done_at` | время |
| `cancel_reason` | причина отмены |
| `note` | короткая заметка разбирающего |

Шаги — отдельная таблица `steps`: `(card_id, seq, text, done, done_at)`.
Шаги не карточки, не очередь, не статусы. Это чек-лист. Исполнитель отмечает
их сам; на переходы статусов они не влияют.

Ссылки и документы — таблица `refs`: `(card_id, kind, value, title)`.
`kind`: `link`, `doc`, `spec`. В `body` можно писать всё остальное.

Обсуждение — таблица `discussion`: вопросы, допущения, комментарии, ответы.
Элемент обсуждения имеет `kind`, `status` (`open`, `answered`, `closed`),
автора и время. Вопрос владельцу — это `kind=question`, `status=open`.

Журнал карточки — таблица `events`: кто, когда, что изменил, причина.
`card show` печатает журнал. Важные решения и допущения дополнительно
попадают в общий md (§ 6).

### 3.2 Группы и ID

Группа — префикс, который вводится при создании карточки. Отдельной сущности
«группа» нет: таблица `groups` хранит только префикс, счётчик и имя.

```
board card add --group UI --title "Форма входа" --skill dev
→ UI-1
board card add --group UI --title "Валидация" --skill dev
→ UI-2
board card add --group IM --title "Статья про запуск" --skill marketing
→ IM-1
```

Префикс — 1–8 символов `A-Z0-9`, приводится к верхнему регистру. Счётчик
атомарный, внутри транзакции. ID не переиспользуется. Группа не удаляется.

### 3.3 Навыки и исполнители

Исполнитель:

| Поле | Смысл |
|---|---|
| `id` | `owner`, `developer`, `marketer` |
| `kind` | `human` или `agent` |
| `skills` | набор навыков |
| `run_size` | сколько карточек в забеге, по умолчанию 3 |
| `worktree` | путь рабочего дерева для агента |
| `last_seen` | последняя активность |

Владелец — исполнитель `owner`, `kind=human`, навык `owner`. Он утверждает
карточки, отвечает на вопросы, делает owner-карточки и релизит. Владелец может
взять любую карточку; агенты ограничены своими навыками.

Правило: **создавать карточки может кто угодно, выполнять — только носитель
требуемого навыка**. Маркетолог может создать `UI-5` с навыком `dev`; разработчик
её выполнит. Наоборот тоже работает.

### 3.4 Зависимости

Зависимости — направленные рёбра `card → card`: `UI-1` не может начаться, пока
`UI-5` не в `review`/`done`. Иерархии нет. Карточка, созданная при разборе, — не
дочерняя, а отдельная; связь только через зависимость.

- Циклы запрещены, ошибка печатает путь.
- `review` и `done` удовлетворяют зависимость; `blocked`, `in_progress`,
  `ready`, `booked` — нет.
- Если зависимость переоткрыта, зависимые, ещё не начатые, возвращаются в
  `waiting`; зависимые в работе получают предупреждение, их `finish`
  блокируется, пока зависимость снова не станет `review`/`done`.
- `cancelled` зависимость удовлетворяет только если владелец явно сказал
  «считать закрытой»; по умолчанию зависимые блокируются с причиной.

## 4. Статусы

| Статус | Группа | Смысл |
|---|---|---|
| `new` | ждёт | запрос создан, ждёт разбора |
| `shaping` | в процессе | кто-то разбирает, держит `holder` |
| `approval` | ждёт | разобран, ждёт утверждения владельцем |
| `waiting` | ждёт | утверждён, зависимости не закрыты |
| `ready` | ждёт | утверждён, зависимости закрыты, можно бронировать |
| `booked` | ждёт | забронирован в забеге, ещё не начат |
| `in_progress` | в процессе | выполняется |
| `blocked` | ждёт | нужен владелец или решение |
| `review` | ждёт | работа сдана, ждёт ревью |
| `done` | закрыт | принят; для `needs_merge` — в `dev`, ждёт `main` |
| `cancelled` | закрыт | отменён |

`merged` как статус **не нужен**. Состояние «в `dev`/в `main`» — отдельные
флаги, вычисляемые из git. `done` без `needs_merge` — финал. `done` с
`needs_merge` — работа принята и лежит в `dev`, ждёт релиза.

### 4.1 Переходы

```
new ──shape──→ shaping ──submit──→ approval ──approve──→ waiting / ready
approval ──reject──→ new (с причиной; содержимое сохраняется)
waiting ──зависимости закрылись──→ ready
ready ──book──→ booked ──take──→ in_progress
booked ──run end / release──→ ready
in_progress ──block──→ blocked ──ответ/решение──→ ready
in_progress ──finish──→ review (review_required) / done
review ──done──→ done
review ──reopen──→ ready (без закрепления за автором; previous_holder)
done ──reopen──→ ready (с причиной)
любой открытый ──cancel──→ cancelled
```

- `block` во время разбора: статус `blocked`, фаза остаётся `request`;
  после ответа владельца — `new`, чтобы карточку мог продолжить любой.
- `block` во время выполнения: статус `blocked`, фаза `task`; после ответа —
  `ready`.
- `shaping` — активный статус, но не забег. Держится lease; если разбирающий
  пропал, карточка возвращается в `new`.
- Владелец может отменить любую карточку; исполнитель — только свою
  `booked`/`in_progress` (с причиной). Отмена `done`/`review` требует причины
  и блокирует release, если код уже в `dev`.

Причина обязательна у `block`, `cancel`, `reject`, `reopen`; `finish` требует
краткий отчёт `--summary`. Каждый переход пишется в `events` с автором,
временем и причиной. Без причины команда отказывает.

### 4.2 Owner-карточки

Карточка с навыком `owner`:

- создаётся сразу в `ready`, без разбора и утверждения;
- не бронируется и не переходит в `in_progress`;
- владелец отмечает `done` одной командой;
- `needs_merge` по умолчанию `false`;
- видна в `now 0`.

Если агент создал owner-карточку, она тоже появляется в `now 0`; владелец
делает её и закрывает. Зависимые карточки ждут её `done`.

## 5. Очередь

### 5.1 Две фазы, один список

- **Запросы** (`phase=request`): `new`, `shaping`, `blocked` во время разбора.
  Порядок — по времени создания. Оценки ещё нет.
- **Задачи** (`phase=task`): `waiting`, `ready`, `booked`, `in_progress`,
  `blocked` во время выполнения, `review`. Порядок — по `position`.
  `approval` — ещё не задача: она ждёт владельца и живёт в `now 0`, пока не
  утверждена. После утверждения получает `position` и входит в очередь.

`now 3` показывает обе секции. Очередь задач — 15 строк, дальше `...`.
Запросы — до 10 строк, дальше `...`.

### 5.2 Оценка и вставка

Разбирающий ставит `importance` и `urgency` от 1 до 5. Базовая оценка —
`importance + urgency`. При утверждении карточка вставляется в очередь задач:

- после последней карточки с оценкой больше или равной новой;
- при равной оценке — после всех равных (то есть в конец группы равных);
- если очередь пуста — в начало.

Ручная перестановка меняет `position` и не меняет оценки. Изменение оценок
после утверждения не двигает карточку само по себе; для пересчёта есть
`queue move` / `queue reorder`.

Позиция — целое число; после перемещения позиции перенумеровываются.
Просто и предсказуемо для доски на сотни карточек.

### 5.3 Ручное управление

```
board queue move UI-4 --before UI-2
board queue move UI-4 --top
board queue move UI-4 --bottom
board queue reorder
```

`queue reorder` пересобирает порядок по оценкам, сохраняя ручные сдвиги
только там, где оценки равны. Это явная команда, а не побочный эффект.

## 6. Решения и допущения

Один общий файл `docs/board/decisions.md`. База — истина; файл генерируется
инструментом при каждом изменении и перезаписывается атомарно (temp + rename).
Ручные правки файла не являются командами и будут перезаписаны.

Запись:

```
### D12 · UI-4 · 2026-11-19 · w1
**Решение:** используем VK API, а не парсинг.
**Статус:** актуально
```

- `D<n>` — атомарный счётчик.
- `kind`: `decision` или `assumption`.
- `status`: `actual`, `cancelled` (с `superseded_by`), `irrelevant`.
- Актуальные — сверху, в порядке создания; неактуальные — в конце,
  зачёркнутые (`~~...~~`).
- Карточка ссылается на `D<n>`; решение может ссылаться на карточку.

Команды:

```
board decision add UI-4 "Используем VK API" --kind decision
board decision supersede D12 --by D15 --reason "VK закрыл доступ"
board decision obsolete D7 --reason "неактуально после смены платформы"
```

Обсуждение карточки (вопросы, ответы, мелкие комментарии) остаётся в базе и
печатается в `card show`. В md попадают только важные решения и допущения.

## 7. Git — вариант B

### 7.1 Изоляция

- Репозиторий имеет `main` и `dev`.
- Тулбокс создаёт worktree на исполнителя: `.worktrees/<executor-id>`.
  Человек может работать в своём клоне; тогда worktree не создаётся.
- Ветка на карточку: `card/<ID>` от свежего `dev`.
- Один исполнитель — один worktree; карточки выполняются последовательно.
  Если агенту нужно несколько параллельных сессий, worktree создаётся на
  сессию (параметр `--worktree <path>`).

### 7.2 Finish

`finish <ID>` делает:

1. Проверяет, что карточка у этого исполнителя и в `in_progress`.
2. Проверяет, что worktree чистый.
3. Проверяет diff `dev...card/<ID>` против `scope`; файлы вне scope —
   ошибка, мержа нет.
4. Мержит `card/<ID>` в `dev` с `--no-ff`. Конфликт — остановка, конфликт
   разруливает агент, затем повторный `finish`.
5. Записывает `merge_commit` и `in_dev=true`.
6. Ставит `review`, если `review_required`, иначе `done`.

Для `needs_merge=false` шаги 2–5 пропускаются: карточка сразу `review`/`done`.

Если `finish` запущен с `--no-merge`, тулбокс не мержит, а только проверяет,
что `card/<ID>` уже является предком `dev`; иначе ошибка. Это аварийный путь
для нестандартного мержа.

### 7.3 Состояние в git

`in_dev` и `in_main` считаются через
`git merge-base --is-ancestor <merge_commit> dev|main`. Значения кэшируются
в карточке и обновляются на `finish`, `release` и `doctor`/`now` при
необходимости. Источник истины по мержу — git; база хранит кэш.

`dev опережает main на N карточек` — это количество карточек с
`needs_merge=true`, `in_dev=true`, `in_main=false`, независимо от статуса.
Карточки в `review` и в переоткрытии (`ready`/`in_progress`/`blocked`)
считаются, потому что их код уже в `dev`.

### 7.4 Review

Карточка в `review` уже в `dev` (для `needs_merge`). Ревьюер видит:

- `git diff <merge_commit>^1 <merge_commit>` — изменения только этой карточки;
- `body`, шаги, ссылки, `scope`, историю обсуждения;
- что проверять: шаги и текст карточки.

Ревью не блокирует зависимости. Оно блокирует только `main`: `release`
отказывается, пока есть карточки в `review` или переоткрытые карточки,
чей код уже в `dev`.

### 7.5 Release

`release` — команда владельца:

1. Проверяет, что в `dev` нет карточек с `in_dev=true` и статусом не `done`
   (review, ready-переоткрытие, in_progress-переоткрытие, blocked, cancelled).
   Отменённая карточка в `dev` требует revert или явного
   `release --force --reason "..."`; без этого релиз не проходит.
2. Мержит `dev` в `main` с `--no-ff`.
3. Обновляет `in_main` для всех карточек, чьи merge-коммиты стали предками
   `main`.
4. Пишет событие релиза. Тег и changelog — опционально, по умолчанию нет.

После релиза все `done`-карточки в `main` остаются `done`; счётчик
«dev опережает main» уменьшается.

### 7.6 needs_merge=false

Карточки без мержа (owner, маркетинг вне репозитория, внешние действия) не
трогают git: нет ветки, нет worktree, нет `in_dev`/`in_main`. `review` для них
проверяет артефакт по ссылкам и шагам. `release` их не касается.

### 7.7 Ограничения

- Большие бинарники (картинки маркетолога) — Git LFS или `needs_merge=false`,
  если они не должны жить в репозитории.
- Shared-файлы (`package.json`, конфиги) должны быть в `scope` той карточки,
  которая их меняет; иначе `finish` не пропустит.
- Конфликты в shared-файлах решает агент; тулбокс только останавливает мерж.

## 8. Забег

Забег — сессия бронирования, а не отдельная очередь. Очередь остаётся
карточной; забег — предложение, которое агент подтверждает (вариант C).

### 8.1 Предложение

`now 1` и `now 2` строят вероятные забеги:

1. Взять верхнюю доступную карточку исполнителя (по `position`, с учётом
   навыка).
2. Добирать до `run_size` карточки той же группы, доступные сейчас или
   становящиеся доступными после уже выбранных (зависимости внутри забега).
3. Если группы не хватает — добирать из других групп.
4. Проверить, что порядок забега удовлетворяет зависимостям.
5. Три забега для `now 1` — непересекающиеся; для `now 2` — по одному на
   каждого другого исполнителя.

Предложение ничего не бронирует. `run start` — отдельная команда.

### 8.2 Бронирование

```
board run start --as developer --cards UI-1,UI-3,UI-5
board run start --as developer --suggest 1
```

Валидация атомарная:

- карточки существуют, фаза `task`, статус `ready` или `waiting`;
- навык подходит исполнителю;
- карточка не забронирована другим;
- зависимости либо закрыты, либо входят в этот забег раньше по порядку;
- `run_size` не превышен.

При ошибке не бронируется ничего. Успех: карточки `booked`, `run_id`,
lease на 2 часа (настраивается). `run start` пишет run-запись и события.

### 8.3 Выполнение

```
board take UI-1 --as developer      # booked → in_progress
board finish UI-1 --as developer --summary "..."  # review/done
board block UI-1 --as developer --reason needs_decision --note "..."
board run next --as developer       # следующая карточка забега
```

`block` освобождает карточку от исполнителя; агент берёт следующую.
Заблокированная карточка остаётся `blocked` и ждёт владельца.

`take` проверяет зависимости ещё раз: если зависимость не в `review`/`done`
и не закрыта раньше в этом же забеге, карточку брать нельзя. Порядок забега
строится так, чтобы это было выполнено.

### 8.4 Завершение

```
board run end --as developer
```

- `booked`-карточки возвращаются в `ready`/`waiting`;
- `in_progress` должны быть закрыты, заблокированы или отпущены; иначе
  команда просит сначала разобраться;
- `blocked` остаются как есть;
- run-запись получает `ended_at`, результат и список карточек;
- если в забеге запланировано ревью, оно запускается до `ended_at`
  (см. § 9).

Если агент умер, lease истекает, карточки возвращаются в очередь, run
закрывается с причиной `lease_expired`. Владелец может снять бронь вручную.

### 8.5 Lease

- `shaping` — 30 минут;
- `booked`/`in_progress` — 2 часа;
- `touch <ID>` продлевает; каждая команда карточки тоже продлевает.
- Просроченные lease снимаются при `now`, `doctor` и любой команде,
  затрагивающей карточку.

## 9. Ревью

### 9.1 Когда

`review_required` ставит разбирающий. Исполнитель в `finish` сам решает,
поставить `review` или `done` — но если `review_required=true`, `finish`
ставит только `review`. Обойти нельзя.

### 9.2 Пакетное ревью

```
board review list --json
```

отдаёт все карточки в `review`: ID, заголовок, body, шаги, ссылки, scope,
branch, merge_commit, diff-команду, историю обсуждения.

Команда/скилл `review` в OpenCode запускает **нового субагента** с этим
пакетом. Субагент проверяет все карточки, затем по каждой:

```
board card verdict UI-1 --done --note "..."
board card verdict UI-4 --reopen --note "..."
```

CLI сам субагентов не порождает: он готовит пакет и принимает вердикты.
Порождение субагента — задача OpenCode-команды/скилла.

### 9.3 Вердикты

- `done`: статус `done`. Для `needs_merge` карточка остаётся в `dev`, ждёт
  `main`. Для `needs_merge=false` — финал.
- `reopen`: статус `ready`, `previous_holder` записан, автор не закреплён.
  Замечания — в обсуждение и в `note`. Карточка возвращается в начало
  очереди (позиция 1), чтобы переработку взяли быстро; владелец может
  переставить.
- Зависимые, ещё не начатые, — в `waiting`; в работе — предупреждение,
  `finish` блокируется, пока зависимость снова не `review`/`done`.
- `release` блокируется, пока переоткрытая карточка с `in_dev=true` не
  вернётся в `done`.

### 9.4 Ревью в забеге

Забег может включать ревью: `run end --review` или `run review`. Тогда
пакетное ревью запускается до закрытия run-записи, а результат пишется в
неё. Ревью проверяет все карточки в `review`, не только карточки забега.

### 9.5 Чужой навык

Ревьюер — свежий субагент. Для карточек с навыком `marketing` он получает
контентный контекст, для `dev` — код и diff. Если ревью требует навыка,
которого у субагента нет, владелец решает сам или назначает другого
ревьюера.

## 10. Разбор и брейншторм

### 10.1 Разбор

```
board card shape UI-1 --as developer
```

Карточка становится `shaping`, holder = developer. Разбирающий заполняет:

- body: что хочу, ссылки, документация, ограничения;
- шаги;
- навык, `importance`, `urgency`;
- `needs_merge`, `review_required`, `scope`;
- зависимости;
- новые карточки (отдельные запросы).

Правила разбора: `review_required` по умолчанию `false`; для
`needs_merge=true` `scope` обязателен — иначе `finish` не сможет отличить
свои файлы от чужих. Для `needs_merge=false` scope не нужен.

Затем:

```
board card submit UI-1 --as developer
→ approval
```

Владелец видит карточку в `now 0`:

```
board card approve UI-1
board card reject UI-1 --reason "..."
```

При отказе — `new`, содержимое сохраняется, причина в обсуждении. Разбирать
может любой, не только автор.

### 10.2 Брейншторм

Брейншторм включается, когда в запросе или по ходу разбора есть открытые
вопросы. Агент использует навык `brainstorming`: задаёт вопросы владельцу,
фиксирует варианты, получает выбор. Вопросы и ответы — в обсуждении
карточки. Важные решения — в `decisions.md`.

Пока вопрос открыт, карточка `blocked`; разбор не продолжается. После
ответа — `new`, карточку может продолжить любой.

Брейншторм не обязателен, если вопросов нет: разбирающий заполняет карточку
и отправляет на утверждение.

### 10.3 Авто-ран

В v1 нет. На будущее: в авто-ране вопросы остаются в обсуждении, карточка
не берётся на исполнение, агент берёт следующую. Утверждение владельцем в
авто-ране не требуется. Модель карточки это выдержит без изменения схемы.

## 11. Доска `now`

`now` — терминальная доска. Вкладки нумеруются; имя печатается в заголовке.
Номер без имени — для скорости, имя — для человека.

### 11.1 `now` / `now 3` — открытые карточки

```
[3] ОТКРЫТЫЕ КАРТОЧКИ
СДЕЛАНО СЕГОДНЯ: 7 · dev опережает main на 3
ПОСЛЕДНИЕ 5 DONE
  UI-12  Онбординг        developer  14:20
  IM-3   Пост в VK        marketer   13:05
  UI-11  Форма            developer  12:40
  IM-2   Статья           marketer   11:15
  UI-9   VK группа        owner      10:02

ЗАПРОСЫ (2)
  UI-20  Новый лендинг          new
  UI-18  Поправить тексты       shaping marketer

ОЧЕРЕДЬ (15)
  1  UI-4   Форма входа       в работе      developer  шаги 2/4
  2  UI-7   Валидация         доступна
  3  IM-4   Статья про X      ждёт UI-7
  4  UI-10  Метрики           забронирована marketer
  ...
```

- «Последние 5 done» — по `done_at`, включая owner-карточки и карточки без
  мержа.
- «dev опережает main» — количество карточек в `dev`, не в `main` (§ 7.3).
- «Запросы» — до 10, потом `...`.
- «Очередь» — 15, потом `...` вместо ID.
- Статусы в очереди печатаются словами: `ждёт`, `доступна`, `забронирована`,
  `в работе`, `на ревью`, `заблокирована`.
- `шаги 2/4` — прогресс чек-листа.

Фильтры:

```
board now 3 --group UI
board now 3 --status ready,waiting
board now 3 --skill dev
board now 3 --mine
board now 3 --phase request
board now 3 --limit 50
board now 3 --all
```

`--all` снимает лимиты. `--json` отдаёт структуру для агентов.

### 11.2 `now 0` — владельцу

```
[0] ВЛАДЕЛЬЦУ
УТВЕРДИТЬ (2)
  UI-10  Онбординг        developer  важность 4, срочность 5
  IM-5   План статей      marketer   важность 3, срочность 3
ЗАДАЧИ (1)
  UI-9   Создать VK группу          owner
ВОПРОСЫ (1)
  UI-6   Нужен ли SSO?              спрашивает developer
```

Вкладка включает:

- карточки в `approval`;
- owner-карточки в `ready`;
- открытые вопросы к владельцу;
- переоткрытые после ревью карточки, если нужен выбор владельца.

### 11.3 `now 1` — мои забеги

Для текущего исполнителя (`--as`, по умолчанию `owner`):

```
[1] МОИ ЗАБЕГИ — developer
ЗАБЕГ 1  UI-4, UI-7, UI-11   (UI)
ЗАБЕГ 2  UI-12, UI-13, UI-14 (UI)
ЗАБЕГ 3  IM-2, IM-4, IM-8    (IM)
```

Для владельца — три ближайших забега по всей доске, по кругу между
исполнителями. Предложения не бронируют.

### 11.4 `now 2` — все забеги

```
[2] ЗАБЕГИ
RUN-1  developer  UI-4, UI-7, UI-11   в работе
RUN-2  marketer   IM-2, IM-4, IM-8    забронирован
RUN-3  developer  UI-12, UI-13, UI-14 завершён: done 2, review 1
СЛЕДУЮЩИЕ
  developer  UI-15, UI-16, UI-17
  marketer   IM-9, IM-10, IM-11
```

Показывает активные и забронированные забеги, результаты прошлых и по
одному вероятному забегу на каждого другого исполнителя (кроме владельца и
текущего).

## 12. CLI

```
board init
board executor add developer --kind agent --skills dev
board executor add marketer --kind agent --skills marketing
board executor add owner --kind human --skills owner

board card add --group UI --title "..." --skill dev [--body "..."]
board card list [--phase request|task] [--status ...] [--skill ...]
board card show UI-1
board card edit UI-1 --title ...
board card shape UI-1 --as developer
board card submit UI-1 --as developer
board card approve UI-1
board card reject UI-1 --reason "..."
board card verdict UI-1 --done|--reopen --note "..."

board queue move UI-4 --before UI-2
board queue reorder

board run start --as developer --cards UI-1,UI-7,UI-11
board run start --as developer --suggest 1
board run next --as developer
board run end --as developer [--review]
board run list

board take UI-1 --as developer
board finish UI-1 --as developer --summary "..."
board block UI-1 --as developer --reason needs_decision --note "..."
board cancel UI-1 --reason "..."
board reopen UI-1 --reason "..."
board touch UI-1 --as developer

board ask UI-1 "Нужен ли SSO?" --as developer [--block]
board answer UI-1 "Нет" --as owner

board decision add UI-1 "..." --kind decision
board decision supersede D12 --by D15 --reason "..."
board decision obsolete D7 --reason "..."

board review list [--json]
board release

board now [0|1|2|3] [фильтры]
board doctor
```

Все команды принимают `--json`. Коды выхода: `0` успех, `1` делать нечего,
`2` нужно решение владельца, `3` ошибка. `--as` обязателен там, где действие
зависит от исполнителя; для owner-команд по умолчанию `owner`.

## 13. Данные

Новая база `.board/board.db`, схема v1. Старые базы не мигрируются.

```sql
create table meta (key text primary key, value text not null);

create table executors (
  id text primary key,
  kind text not null,
  skills text not null default '[]',
  run_size integer not null default 3,
  worktree text,
  last_seen text
);

create table groups (
  prefix text primary key,
  next_seq integer not null default 1,
  name text,
  created_at text not null
);

create table cards (
  id text primary key,
  group_prefix text not null,
  group_seq integer not null,
  title text not null,
  body text not null default '',
  phase text not null default 'request',
  status text not null,
  skill text,
  importance integer,
  urgency integer,
  position integer,
  needs_merge integer not null default 1,
  review_required integer not null default 0,
  scope text not null default '[]',
  holder text,
  run_id text,
  branch text,
  merge_commit text,
  in_dev integer not null default 0,
  in_main integer not null default 0,
  lease_until text,
  previous_holder text,
  created_at text not null,
  updated_at text not null,
  shaped_at text,
  approved_at text,
  done_at text,
  cancel_reason text,
  note text
);
create index idx_cards_status on cards(status);
create index idx_cards_phase on cards(phase, position);

create table steps (
  card_id text not null references cards(id) on delete cascade,
  seq integer not null,
  text text not null,
  done integer not null default 0,
  done_at text,
  primary key (card_id, seq)
);

create table refs (
  id integer primary key autoincrement,
  card_id text not null references cards(id) on delete cascade,
  kind text not null,
  value text not null,
  title text,
  created_at text not null
);

create table deps (
  from_id text not null,
  to_id text not null,
  primary key (from_id, to_id)
);

create table discussion (
  id integer primary key autoincrement,
  card_id text not null references cards(id) on delete cascade,
  author text not null,
  kind text not null,
  text text not null,
  status text not null default 'open',
  answer_to integer,
  created_at text not null,
  answered_at text
);

create table events (
  id integer primary key autoincrement,
  at text not null,
  type text not null,
  actor text not null,
  subject text not null,
  before text,
  after text,
  note text
);
create index idx_events_subject on events(subject, id);

create table runs (
  id text primary key,
  executor_id text not null,
  status text not null,
  created_at text not null,
  started_at text,
  ended_at text,
  review integer not null default 0,
  note text
);

create table run_cards (
  run_id text not null references runs(id) on delete cascade,
  card_id text not null,
  position integer not null,
  status text not null,
  primary key (run_id, card_id)
);

create table decisions (
  id text primary key,
  card_id text,
  kind text not null,
  text text not null,
  status text not null default 'actual',
  superseded_by text,
  author text not null,
  created_at text not null,
  updated_at text not null
);

create table reviews (
  id integer primary key autoincrement,
  card_id text not null,
  reviewer text not null,
  verdict text not null,
  note text,
  at text not null
);
```

Конкурентность: `node:sqlite`, WAL, `busy_timeout`, `begin immediate` для
бронирования и ID. Все переходы статусов — в транзакции.

## 14. OpenCode

Минимальная интеграция:

- скилл `board` — как смотреть `now`, брать забег, разбирать карточку,
  задавать вопросы, закрывать, ревьюить;
- команда `review` — запускает нового субагента с пакетом `review list`;
- тонкий плагин с инструментами `board_now`, `board_card`, `board_run`,
  `board_take`, `board_finish`, `board_block`, `board_ask`, `board_answer`,
  `board_review`, `board_decision`;
- плагин не содержит логики: вызывает `node bin/board.ts … --json`.

Файлы агентов OpenCode (`developer`, `marketer`) настраиваются вручную.
`init` создаёт скилл, команду ревью и блок в `AGENTS.md` между маркерами.

## 15. Что остаётся за builder'ом

Эти решения не меняют модель и могут быть приняты при реализации:

- имя CLI (`board` или `toolbox-al`);
- точная формула оценки (сумма важности и срочности или матрица);
- длительность lease (2 часа для забега, 30 минут для разбора);
- способ запуска субагента ревью в конкретной версии OpenCode;
- нужен ли `doctor` сверх проверки git/lease/веток;
- LFS для картинок;
- тег и changelog в `release` (по умолчанию нет);
- формат `--json` (плоский или с `data`/`error`).

## 16. Рассмотренные подходы

### Git

- **A. Полный автомат** — тулбокс коммитит, мержит, релизит.
  Отброшен: тащит конфликты, тесты и сборку внутрь доски, это старый тяжёлый
  механизм.
- **B. Изоляция + git у агента** — тулбокс создаёт worktree и ветку, `finish`
  мержит в `dev`, состояние читается из git. **Выбран.**
- **C. Ручные отметки** — агент всё делает сам, доска хранит флаги.
  Отброшен для текущего сценария: состояние врёт, если забыли отметить;
  на одной машине B дешевле.
- **D. Без git** — `done` финал, N приблизительный. Отброшен: нельзя ответить,
  что в `main`.

### Очередь забегов

- **A. Очередь карточек, забег — сессия брони.** Гибко, ручная вставка
  на уровне карточки.
- **B. Очередь забегов.** Планировщик заранее собирает тройки; срочная
  карточка ждёт свой забег, блокировка ломает забег.
- **C. Гибрид.** Очередь карточек, `now` предлагает забег. **Выбран:**
  гибкость A и пакетность B без жёсткой очереди забегов.

## 17. Проверка

Тесты на `node --test`, без внешних зависимостей. Временные каталоги и
temp git-репозитории.

- ID: атомарная выдача в группе, конкурентные вызовы.
- Статусы: все переходы, причины, запрет обхода review.
- Очередь: вставка по оценке, равные — в конец, ручной move, reorder.
- Зависимости: циклы, ready/waiting, review открывает, отказ ревью
  возвращает зависимых в waiting.
- Забег: скиллы, зависимости внутри забега, атомарность, двойное
  бронирование, lease, run end.
- Git: worktree, ветка, scope, merge --no-ff, конфликт, `in_dev`/`in_main`,
  release-гейт, `needs_merge=false`.
- Ревью: пакет, done/reopen, previous_holder, release-блок.
- Решения: md активные/неактивные, зачёркивание, supersede.
- Доска: `now 0..3`, лимит 15 + `...`, сегодняшний счётчик, dev-ahead.
- Owner-карточки: без брони и approval, done одной командой.
- CLI: `--json`, коды выхода.
- Конкурентность: два процесса бронируют одну карточку — выигрывает один.

## 18. Открыто

- Авто-ран: отдельное обсуждение после v1.
- Точная формула оценки.
- Нужен ли отдельный статус `rework` вместо `ready` с `previous_holder`.
- Как показывать review-карточки в `now 3` (отдельной секцией или в очереди).
- Нужен ли `release` с тегом и changelog.
