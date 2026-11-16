# toolbox-al: ядро и очередь — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Работающий CLI, который принимает запросы, фичи, этапы и задачи, ведёт очередь на исполнителей, аренду и руки — без git, без рутин, без OpenCode.

**Architecture:** Ядро — чистые функции над SQLite в одном процессе, без сервера и демона. Все изменения состояния идут через транзакции и пишутся в append-only журнал; состояние — производное. Время двигается лениво: каждая команда сначала применяет наступившие последствия, поэтому поведение не зависит от наличия демона.

**Tech Stack:** Node 26, TypeScript без сборки (запуск `node bin/toolbox-al.ts`), `node:sqlite`, `node:test` + `node:assert/strict`. Внешних зависимостей нет.

**Spec:** `docs/specs/2026-11-16-toolbox-al-design.md`

## Планы по подсистемам

Спецификация разбита на пять планов. Каждый даёт работающее и проверяемое ПО само по себе.

| План | Что даёт | Зависит от |
|---|---|---|
| **1. Ядро и очередь** (этот) | запросы, фичи, этапы, задачи, аренда, руки, порядок, inbox, now | — |
| 2. Git и слияние | worktree на фичу, коммит по `scope`, слияние этапа в `dev`, релиз | 1 |
| 3. Shaping и ревью | версии плана, вопросы владельцу, ревью, приёмка, шаблоны, `similar` | 1 |
| 4. Рутины | расписание, гейты, календарь, `tick`, планировщик, `friction` | 1, 2 |
| 5. OpenCode | агенты, скиллы, плагин, первичная настройка | 1–4 |

Задачи ниже ссылаются на требования спеки (`M-*`, `Q-*`, `L-*`, `D-*`), чтобы исполнитель мог прочитать исходное правило, а не догадываться.

## Global Constraints

- Node 26, TypeScript без шага сборки. Запуск: `node bin/toolbox-al.ts <команда>`.
- Ноль внешних зависимостей (`dependencies` в `package.json` пуст).
- Все данные — в SQLite через `node:sqlite`, режим WAL.
- Время в базе — UTC ISO-8601 с суффиксом `Z`; `Date` в домене не используется, только строки.
- Каждая мутация — в одной транзакции и с записью в `events`.
- Обязательные поля задачи: `title`, `kind`, `dod` (1–3 пункта), `size`, `skill`, `class`, `scope`.
- `size` допускает `XS|S|M|L`; `L` требует `size_reason`; `XL` отвергается.
- Коды возврата: `0` успех, `1` делать нечего, `2` нужно решение владельца, `3` ошибка.
- `--json` печатает один JSON-объект в stdout и ничего больше.
- Значения по умолчанию: `leaseMinutes=30`, `maxAttempts=3`, `handSize=5`, `offlineAfterMinutes=120`, `ownerStaleDays=3`, `wipLimit=1`.
- Интерфейс CLI и сообщения — по-русски; идентификаторы в коде — по-английски.

## Review Focus

Пять классов входных данных, которые спека подразумевает, но не описывает построчно. Для каждого в задачах ниже есть тест.

1. **Двое берут одну задачу одновременно.** Ожидание: ровно один получает задачу, второй — код `1` и следующую задачу, без исключения и без двойного `holder`. (`Task 9`)
2. **Циклическая зависимость.** Ожидание: отказ при создании с перечислением цикла, а не зависание при выдаче. (`Task 8`)
3. **Все кандидаты в руке заблокированы.** Ожидание: рука остаётся пустой, команда возвращает `1`, без бесконечного цикла пополнения. (`Task 10`)
4. **Исполнитель с неизвестным навыком.** Ожидание: ошибка «навык не найден у исполнителя» при выдаче, а не молчаливая пустая очередь. (`Task 5`, `Task 10`)
5. **Системные часы ушли назад.** Ожидание: истёкшая аренда не «воскресает», задача остаётся возвращённой; повторного `attempts++` нет. (`Task 9`)

---

### Task 1: Каркас, CLI и коды возврата

**Files:**
- Create: `package.json`, `tsconfig.json`, `bin/toolbox-al.ts`, `src/cli/args.ts`, `src/cli/output.ts`, `src/cli/errors.ts`
- Test: `tests/cli/args.test.ts`, `tests/cli/output.test.ts`

**Interfaces:**
- Produces: `parseArgs(argv: string[]): { command: string; sub: string | null; flags: Record<string, string | boolean>; positionals: string[] }`
- Produces: `ok(data: unknown, human: string): void`, `fail(code: 1|2|3, message: string): never`
- Produces: `class UserError extends Error { code: number }`

- [ ] **Step 1: Write the failing test**

```ts
import test from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs } from '../../src/cli/args.ts'

test('разбирает команду, подкоманду, флаги и позиционные', () => {
  const r = parseArgs(['task', 'add', 'F1.S1', '--size', 'S', '--json', '--dod', 'a'])
  assert.equal(r.command, 'task')
  assert.equal(r.sub, 'add')
  assert.deepEqual(r.positionals, ['F1.S1'])
  assert.equal(r.flags.size, 'S')
  assert.equal(r.flags.json, true)
  assert.equal(r.flags.dod, 'a')
})

test('неизвестный флаг отвергается', () => {
  assert.throws(() => parseArgs(['now', '--nope']), /неизвестный флаг/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/cli/args.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: Implement `parseArgs` and CLI plumbing**

`src/cli/args.ts`: known-flags allowlist per command, `--flag value` and `--flag` boolean, reject unknown. `src/cli/errors.ts`: `UserError`. `src/cli/output.ts`: `ok` prints JSON when `--json`, otherwise the human string; `fail` writes to stderr and sets `process.exitCode`.

`bin/toolbox-al.ts` dispatches `command + sub` to `src/cli/commands/<command>.ts`, catching `UserError` and printing `message`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/cli/`
Expected: PASS, 2 tests.

- [ ] **Step 5: Commit**

```bash
git add package.json tsconfig.json bin src/cli tests/cli
git commit -m "feat: cli skeleton with args, output and exit codes"
```

---

### Task 2: База, миграции, журнал событий

**Files:**
- Create: `src/core/db.ts`, `src/core/schema.ts`, `src/core/events.ts`
- Test: `tests/core/db.test.ts`, `tests/core/events.test.ts`

**Interfaces:**
- Produces: `openDb(path: string): DatabaseSync` (WAL, `busy_timeout=5000`, foreign keys on)
- Produces: `migrate(db: DatabaseSync): number` — идемпотентна, возвращает текущую `schemaVersion`
- Produces: `tx<T>(db: DatabaseSync, fn: () => T): T`
- Produces: `appendEvent(db, e: { type: string; actor: string; subject: string; before?: unknown; after?: unknown; note?: string }): void`
- Produces: `listEvents(db, filter?: { subject?: string; since?: string }): Event[]`

- [ ] **Step 1: Write the failing test**

```ts
test('миграция идемпотентна и создаёт таблицы', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), 1)
  assert.equal(migrate(db), 1)
  const names = db.prepare("select name from sqlite_master where type='table'").all().map(r => r.name)
  for (const t of ['meta', 'events', 'executors', 'requests', 'features', 'stages', 'tasks', 'deps', 'hand', 'questions'])
    assert.ok(names.includes(t), t)
})

test('событие пишется и читается в порядке вставки', () => {
  const db = openDb(':memory:'); migrate(db)
  appendEvent(db, { type: 'task.created', actor: 'orchestrator', subject: 'F1.S1-1' })
  appendEvent(db, { type: 'task.taken', actor: 'w1', subject: 'F1.S1-1' })
  assert.deepEqual(listEvents(db, { subject: 'F1.S1-1' }).map(e => e.type), ['task.created', 'task.taken'])
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/core/db.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement schema and events**

`src/core/schema.ts` holds the v1 DDL as one string: `meta(key,value)`, `events(id, at, type, actor, subject, before, after, note)`, plus the tables listed in the test, with the columns from `Task 5–13`. `node:sqlite` has no `user_version` helper — store `schemaVersion` in `meta`.

`src/core/db.ts` opens, sets pragmas, runs `migrate` on open.

`src/core/events.ts` inserts with `at = new Date().toISOString()`, `before`/`after` as JSON text.

- [ ] **Step 4: Run tests**

Run: `node --test tests/core/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core tests/core
git commit -m "feat: sqlite schema, migrations and event journal"
```

---

### Task 3: Идентификаторы и слаги

**Files:**
- Create: `src/core/ids.ts`
- Test: `tests/core/ids.test.ts`

**Interfaces:**
- Produces: `allocateId(db, kind: 'request'|'feature'|'stage'|'task'|'question'): string` — `R1`, `F1`, `S1` (локальный), `T1`, `Q1`
- Produces: `childId(parent: string, kind: 'stage'|'task', index: number): string` — `F1.S2`, `F1.S2-3`
- Produces: `slugify(title: string): string` — транслитерация, нижний регистр, дефисы

- [ ] **Step 1: Write the failing test**

```ts
test('id монотонны и не переиспользуются', () => {
  assert.equal(allocateId(db, 'feature'), 'F1')
  assert.equal(allocateId(db, 'feature'), 'F2')
})

test('дочерние id читаемы', () => {
  assert.equal(childId('F7', 'stage', 2), 'F7.S2')
  assert.equal(childId('F7.S2', 'task', 3), 'F7.S2-3')
})

test('slug транслитерирует кириллицу', () => {
  assert.equal(slugify('Оплата подписки'), 'oplata-podpiski')
  assert.equal(slugify('Враг-стрелок «Босс»'), 'vrag-strelok-boss')
})
```

- [ ] **Step 2: Run** `node --test tests/core/ids.test.ts` → FAIL

- [ ] **Step 3: Implement**

Counters in `meta` (`counter.feature` и т.д.), `allocateId` in `tx`. Transliteration table for `а-я`, `ё`, plus `ь/ъ` dropped.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/ids.ts tests/core/ids.test.ts
git commit -m "feat: stable ids and cyrillic slugs"
```

---

### Task 4: `init`, поиск проекта, конфиг

**Files:**
- Create: `src/core/project.ts`, `src/core/config.ts`, `src/cli/commands/init.ts`
- Modify: `bin/toolbox-al.ts`
- Test: `tests/core/project.test.ts`, `tests/cli/init.test.ts`

**Interfaces:**
- Produces: `findProject(startDir: string): { root: string; dbPath: string; config: Config } | null` — идёт вверх до `.toolbox-al/config.json`
- Produces: `initProject(dir: string): { created: string[] }` — создаёт `.toolbox-al/config.json`, `.toolbox-al/tracker.db`, `.gitignore` запись; идемпотентна
- Produces: `type Config = { toolVersion: string; schemaVersion: number; leaseMinutes: number; maxAttempts: number; handSize: number; offlineAfterMinutes: number; ownerStaleDays: number; wipLimit: number; branches: { main: string; dev: string }; locale: string }`

- [ ] **Step 1: Write the failing test**

```ts
test('init идемпотентен и не затирает конфиг', () => {
  const r1 = initProject(tmp)
  assert.ok(r1.created.includes('.toolbox-al/config.json'))
  writeFileSync(join(tmp, '.toolbox-al/config.json'), '{"leaseMinutes":99}')
  initProject(tmp)
  assert.equal(JSON.parse(readFileSync(join(tmp, '.toolbox-al/config.json'), 'utf8')).leaseMinutes, 99)
})

test('поиск проекта идёт вверх по дереву', () => {
  initProject(tmp)
  mkdirSync(join(tmp, 'src/deep'), { recursive: true })
  assert.equal(findProject(join(tmp, 'src/deep'))?.root, tmp)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`init` никогда не перезаписывает существующий файл; `--yes` не задаёт вопросов; вывод перечисляет созданное и, по `S-2`, говорит, что первичную настройку выполняет агент.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/project.ts src/core/config.ts src/cli/commands/init.ts tests
git commit -m "feat: project discovery and idempotent init"
```

---

### Task 5: Исполнители

**Files:**
- Create: `src/core/executors.ts`, `src/cli/commands/executor.ts`
- Test: `tests/core/executors.test.ts`

**Interfaces:**
- Produces: `addExecutor(db, { id: string; kind: 'human'|'agent'; skills: string[]; wipLimit?: number; handSize?: number }): Executor`
- Produces: `getExecutor(db, id: string): Executor | null`
- Produces: `touchExecutor(db, id: string): void` — обновляет `last_seen`
- Produces: `assertSkill(executor: Executor, skill: string): void` — бросает `UserError('навык <s> не найден у исполнителя <id>')`

- [ ] **Step 1: Write the failing test**

```ts
test('исполнитель хранит набор навыков и wip', () => {
  const e = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend', 'design'] })
  assert.deepEqual(e.skills, ['backend', 'design'])
  assert.equal(e.wipLimit, 1)
})

test('неизвестный навык даёт понятную ошибку', () => {
  const e = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  assert.throws(() => assertSkill(e, 'audio'), /навык audio не найден/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`skills` — JSON-массив в колонке. Повторное добавление с тем же id — ошибка `UserError`.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/executors.ts src/cli/commands/executor.ts tests/core/executors.test.ts
git commit -m "feat: executors with skill sets"
```

---

### Task 6: Запросы, фичи, этапы

**Files:**
- Create: `src/core/requests.ts`, `src/core/features.ts`, `src/core/stages.ts`, `src/cli/commands/request.ts`, `src/cli/commands/feature.ts`, `src/cli/commands/stage.ts`
- Test: `tests/core/structure.test.ts`

**Interfaces:**
- Produces: `addRequest(db, { title: string; body: string; author: string }): Request` — статус `inbox`
- Produces: `addFeature(db, { requestId: string; name: string; rank: number; reviewPolicy?: 'auto'|'agent'|'owner' }): Feature`
- Produces: `rankFeature(db, featureId: string, rank: number): void` — переставляет остальные, сохраняя непрерывность
- Produces: `addStage(db, { featureId: string; name: string; goal: string; appetite?: string; acceptance?: 'auto'|'owner'|'owner_before_next' }): Stage` — `seq` = следующий, `status='planned'`
- Produces: `activateNextStage(db, featureId: string): Stage | null`

- [ ] **Step 1: Write the failing test**

```ts
test('ранг переставляется без дыр', () => {
  const r = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const f1 = addFeature(db, { requestId: r.id, name: 'A', rank: 1 })
  const f2 = addFeature(db, { requestId: r.id, name: 'B', rank: 2 })
  rankFeature(db, f2.id, 1)
  assert.deepEqual(listFeatures(db).map(f => [f.id, f.rank]), [[f2.id, 1], [f1.id, 2]])
})

test('этапы нумеруются подряд и активируются по одному', () => {
  const s1 = addStage(db, { featureId: 'F1', name: 'S1', goal: 'g' })
  const s2 = addStage(db, { featureId: 'F1', name: 'S2', goal: 'g' })
  assert.equal(s2.seq, 2)
  assert.equal(activateNextStage(db, 'F1')!.id, s1.id)
  assert.equal(activateNextStage(db, 'F1'), null)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`rankFeature` в одной транзакции: сдвиг `rank` у остальных. `activateNextStage` активен максимум один этап (`Q-6.1`).

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/requests.ts src/core/features.ts src/core/stages.ts src/cli/commands tests/core/structure.test.ts
git commit -m "feat: requests, features, stages"
```

---

### Task 7: Задачи и валидация

**Files:**
- Create: `src/core/tasks.ts`, `src/core/validate.ts`, `src/cli/commands/task.ts`
- Test: `tests/core/validate.test.ts`, `tests/core/tasks.test.ts`

**Interfaces:**
- Produces: `validateTaskInput(i: NewTask): { errors: string[]; warnings: string[] }`
- Produces: `createTask(db, i: NewTask): Task` — бросает `UserError` со списком `errors`
- Produces: `getTask(db, id): Task`, `listTasks(db, f?: { stageId?: string; status?: TaskStatus }): Task[]`
- Produces: `type NewTask = { stageId: string; title: string; kind?: 'task'|'defect'|'incident'; dod: string[]; checkCmd?: string; size: 'XS'|'S'|'M'|'L'; sizeReason?: string; skill: string; class: 'expedite'|'fixed_date'|'standard'|'intangible'|'quick'; scope: string[] | 'exclusive' }`
- Produces: `type TaskStatus = 'open'|'ready'|'active'|'blocked'|'needs_owner'|'in_review'|'done'|'cancelled'`

- [ ] **Step 1: Write the failing test**

```ts
test('задача без DoD не создаётся', () => {
  const { errors } = validateTaskInput({ stageId: 'F1.S1', title: 'Добавить оплату', dod: [], size: 'S', skill: 'backend', class: 'standard', scope: ['src/**'] })
  assert.match(errors.join('\n'), /DoD/)
})

test('XL отвергается, L требует причины', () => {
  const base = { stageId: 'F1.S1', title: 'Добавить оплату', dod: ['a'], skill: 'backend', class: 'standard', scope: ['src/**'] } as const
  assert.match(validateTaskInput({ ...base, size: 'XL' as any }).errors.join(' '), /XL/)
  assert.match(validateTaskInput({ ...base, size: 'L' }).errors.join(' '), /причин/)
})

test('заголовок-тема даёт предупреждение, но не отказ', () => {
  const r = validateTaskInput({ stageId: 'F1.S1', title: 'Оплата', dod: ['a'], size: 'S', skill: 'backend', class: 'standard', scope: ['src/**'] })
  assert.equal(r.errors.length, 0)
  assert.equal(r.warnings.length, 1)
})

test('созданная задача получает статус open и id вида F1.S1-1', () => {
  const t = createTask(db, { stageId: s.id, title: 'Добавить вебхук', dod: ['a'], size: 'S', skill: 'backend', class: 'standard', scope: ['src/**'] })
  assert.equal(t.status, 'open')
  assert.equal(t.id, 'F1.S1-1')
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`validate.ts`: hard errors — пустой `dod` (>3 тоже), отсутствие `skill`, `size='XL'`, `size='L'` без причины, пустой `scope`. Warning — заголовок из блоклиста (`оплата`, `фикс`, `доработки`, `разное`) или одно слово. `scope` хранится как JSON; `'exclusive'` — отдельное значение.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/tasks.ts src/core/validate.ts src/cli/commands/task.ts tests/core
git commit -m "feat: tasks with enforced definition of done"
```

---

### Task 8: Зависимости и готовность

**Files:**
- Create: `src/core/deps.ts`
- Test: `tests/core/deps.test.ts`

**Interfaces:**
- Produces: `addDep(db, from: string, to: string): void` — `from` ждёт `to`; отказывает при цикле
- Produces: `wouldCycle(db, from: string, to: string): string[] | null` — путь цикла или `null`
- Produces: `isReady(db, taskId: string): boolean` — все задачи-предшественники в `done`, этап активен
- Produces: `refreshReady(db): number` — переводит `open ↔ ready`, возвращает число изменённых

- [ ] **Step 1: Write the failing test**

```ts
test('прямой цикл отвергается с путём', () => {
  addDep(db, 'F1.S1-1', 'F1.S1-2')
  const cyc = wouldCycle(db, 'F1.S1-2', 'F1.S1-1')
  assert.deepEqual(cyc, ['F1.S1-1', 'F1.S1-2', 'F1.S1-1'])
  assert.throws(() => addDep(db, 'F1.S1-2', 'F1.S1-1'), /цикл/)
})

test('задача готова только когда предшественник закрыт', () => {
  addDep(db, 'F1.S1-1', 'F1.S1-2')
  assert.equal(isReady(db, 'F1.S1-1'), false)
  markDone(db, 'F1.S1-2')
  assert.equal(isReady(db, 'F1.S1-1'), true)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

Обход в глубину по `deps`; при обнаружении возвращаемого пути — `UserError` с циклом. `refreshReady` вызывается из ленивых часов (`Task 9`).

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/deps.ts tests/core/deps.test.ts
git commit -m "feat: dependencies with cycle detection and readiness"
```

---

### Task 9: Часы и аренда

**Files:**
- Create: `src/core/clock.ts`, `src/core/lease.ts`
- Test: `tests/core/lease.test.ts`

**Interfaces:**
- Produces: `advanceTime(db, now?: string): { expired: string[] }` — применяет истёкшие аренды, пересчитывает готовность, освобождает руки offline-исполнителей
- Produces: `takeTask(db, { executor: string; taskId?: string }): Task` — бросает `UserError` код `1`, если брать нечего
- Produces: `touchTask(db, { executor: string; taskId: string }): Task`
- Produces: `releaseTask(db, { taskId: string; reason: string; actor: string }): void`

- [ ] **Step 1: Write the failing test**

```ts
test('истёкшая аренда возвращает задачу и считает попытку', () => {
  const t = takeTask(db, { executor: 'w1', taskId: 'F1.S1-1' })
  assert.equal(t.status, 'active')
  advanceTime(db, plusMinutes(31))
  const after = getTask(db, 'F1.S1-1')
  assert.equal(after.status, 'ready')
  assert.equal(after.attempts, 1)
})

test('двое одновременно: второй получает код 1', () => {
  takeTask(db, { executor: 'w1', taskId: 'F1.S1-1' })
  assert.throws(() => takeTask(db, { executor: 'w2', taskId: 'F1.S1-1' }), (e: any) => e.code === 1)
})

test('часы назад не воскрешают аренду', () => {
  const t = takeTask(db, { executor: 'w1', taskId: 'F1.S1-1' })
  advanceTime(db, plusMinutes(31))
  advanceTime(db, minusMinutes(60))
  assert.equal(getTask(db, 'F1.S1-1').attempts, 1)
})

test('WIP: вторая задача тому же исполнителю не выдаётся', () => {
  takeTask(db, { executor: 'w1', taskId: 'F1.S1-1' })
  assert.throws(() => takeTask(db, { executor: 'w1', taskId: 'F1.S1-2' }), /WIP/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`takeTask` — один `UPDATE tasks SET holder=?, lease_until=?, status='active' WHERE id=? AND status IN ('ready','open') AND holder IS NULL`; `changes === 0` → `UserError(1, 'задача уже занята')`. `advanceTime` идемпотентна: сравнивает `lease_until < now`, при повторном вызове ничего не меняет.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/clock.ts src/core/lease.ts tests/core/lease.test.ts
git commit -m "feat: lazy clock and atomic task lease"
```

---

### Task 10: Рука и порядок

**Files:**
- Create: `src/core/hands.ts`, `src/core/ordering.ts`
- Test: `tests/core/hands.test.ts`

**Interfaces:**
- Produces: `fillHand(db, executorId: string, limit?: number): Task[]`
- Produces: `getHand(db, executorId: string): Task[]`
- Produces: `setHand(db, executorId: string, taskIds: string[], actor: string): void`
- Produces: `compareTasks(a: Task, b: Task): number` — класс, затем размер, затем id
- Produces: `nextTask(db, executorId: string): Task | null`

- [ ] **Step 1: Write the failing test**

```ts
test('рука пополняется задачами того же этапа первыми', () => {
  const hand = fillHand(db, 'w1')
  assert.equal(hand[0].id, 'F1.S1-1')
})

test('все кандидаты заблокированы — рука пуста, без зависания', () => {
  db.prepare("update tasks set status='blocked'").run()
  assert.deepEqual(fillHand(db, 'w1'), [])
})

test('порядок: expedite раньше standard, XS раньше M', () => {
  assert.ok(compareTasks(task({ class: 'expedite', size: 'M' }), task({ class: 'standard', size: 'XS' })) < 0)
  assert.ok(compareTasks(task({ class: 'standard', size: 'XS' }), task({ class: 'standard', size: 'M' })) < 0)
})

test('задача с чужим навыком не попадает в руку', () => {
  createTask(db, { ...base, skill: 'audio', title: 'Записать выстрелы' })
  assert.equal(fillHand(db, 'w1').some(t => t.skill === 'audio'), false)
})

test('зарезервированную задачу не берёт другой исполнитель', () => {
  fillHand(db, 'w1')
  assert.throws(() => takeTask(db, { executor: 'w2', taskId: 'F1.S1-1' }), (e: any) => e.code === 1)
})

test('исполнитель offline теряет руку', () => {
  fillHand(db, 'w2')
  advanceTime(db, plusMinutes(121))
  assert.deepEqual(getHand(db, 'w2'), [])
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`fillHand`: кандидаты `ready`, навык в наборе, этап `active`, не зарезервированы, не держатся; сортировка — сначала текущая фича+этап исполнителя, затем `feature.rank`; резерв в `hand` с `reserved_at`. Пустой набор возвращает `[]` без ошибки. Если есть готовые задачи с навыком, которого нет ни у одного исполнителя, `fillHand` не падает — но `dispatch` предупреждает.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/hands.ts src/core/ordering.ts tests/core/hands.test.ts
git commit -m "feat: executor hands and deterministic ordering"
```

---

### Task 11: Expedite и вытеснение

**Files:**
- Modify: `src/core/lease.ts`, `src/core/hands.ts`, `src/cli/commands/take.ts`
- Test: `tests/core/expedite.test.ts`

**Interfaces:**
- Produces: `takeTask` учитывает expedite первым при `next`
- Produces: `preempt(db, { taskId: string; executor: string; actor: string }): void` — прерывает активную задачу: `blocked` с причиной `preempted`, попытка не растёт, событие `task.preempted` с id вытесненной задачи

- [ ] **Step 1: Write the failing test**

```ts
const base = { stageId: 'F1.S1', dod: ['a'], size: 'S' as const, skill: 'backend', scope: ['src/**'] }

test('expedite выдаётся первым', () => {
  const urgent = createTask(db, { ...base, title: 'Починить оплату', class: 'expedite' })
  assert.equal(nextTask(db, 'w1')!.id, urgent.id)
})

test('лимит: второй active expedite у того же исполнителя отвергается', () => {
  const e1 = createTask(db, { ...base, title: 'Починить вход', class: 'expedite' })
  const e2 = createTask(db, { ...base, title: 'Починить выход', class: 'expedite' })
  takeTask(db, { executor: 'w1', taskId: e1.id })
  assert.throws(() => takeTask(db, { executor: 'w1', taskId: e2.id }), /лимит/)
})

test('preempt пишет в журнал, что вытеснено', () => {
  const running = createTask(db, { ...base, title: 'Добавить профиль', class: 'standard' })
  takeTask(db, { executor: 'w1', taskId: running.id })
  const urgent = createTask(db, { ...base, title: 'Упал прод', class: 'expedite' })
  preempt(db, { taskId: urgent.id, executor: 'w1', actor: 'orchestrator' })
  const ev = listEvents(db, { subject: running.id }).at(-1)!
  assert.equal(ev.type, 'task.preempted')
  assert.match(ev.note, /вытеснено/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`nextTask`: если у исполнителя есть активный expedite — вернуть следующий обычный; если появился expedite — вернуть его. Лимит — `count(active where class='expedite' and holder=?) < 1`.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core tests/core/expedite.test.ts
git commit -m "feat: expedite class with preemption journal"
```

---

### Task 12: Вопросы, inbox, рука владельца

**Files:**
- Create: `src/core/questions.ts`, `src/cli/commands/ask.ts`, `src/cli/commands/inbox.ts`
- Test: `tests/core/questions.test.ts`

**Interfaces:**
- Produces: `ask(db, { addressee: 'owner'|'orchestrator'|'executor'; text: string; options?: string[]; subjectType: 'request'|'task'|'stage'|'routine_step'; subjectId: string; deadline?: string; timeoutPolicy?: 'block'|'proceed' }): Question`
- Produces: `answer(db, { id: string; answer: string; actor: string }): Question`
- Produces: `getQuestions(db, f?: { addressee?: string; status?: string }): Question[]`
- Produces: `ownerHand(db, now?: string): Array<{ kind: 'task'|'question'; deadline?: string; item: Task|Question }>`
- Produces: `inbox(db): Array<{ id: string; kind: 'task'|'question'; deadline?: string; item: Task|Question }>` — тот же список, отформатированный блоками

- [ ] **Step 1: Write the failing test**

```ts
test('вопрос владельцу попадает в inbox и закрывается ответом', () => {
  const q = ask(db, { addressee: 'owner', text: 'ЮKassa или Stripe?', options: ['ЮKassa', 'Stripe'], subjectType: 'request', subjectId: 'R1' })
  assert.ok(inbox(db).some(i => i.id === q.id))
  answer(db, { id: q.id, answer: 'ЮKassa', actor: 'owner' })
  assert.equal(inbox(db).some(i => i.id === q.id), false)
})

test('рука владельца сортирует по сроку, а не по рангу', () => {
  ask(db, { addressee: 'owner', text: 'позже', subjectType: 'request', subjectId: 'R1', deadline: '2030-01-01T00:00:00Z' })
  ask(db, { addressee: 'owner', text: 'срочно', subjectType: 'request', subjectId: 'R1', deadline: '2020-01-01T00:00:00Z' })
  const h = ownerHand(db).filter(x => x.kind === 'question')
  assert.equal((h[0].item as Question).text, 'срочно')
})

test('задача, закреплённая за владельцем, в его руке', () => {
  assert.ok(ownerHand(db).some(x => x.kind === 'task' && (x.item as Task).holder === 'owner'))
})
```

- [ ] **Step 2: Run** `node --test tests/core/questions.test.ts` → FAIL

- [ ] **Step 3: Implement**

`src/core/questions.ts`: таблица `questions` уже создана в `Task 2`; здесь — операции. `options` хранится JSON-массивом.

`ownerHand` объединяет: задачи с `holder='owner'` и `status='active'`; задачи в `needs_owner`; вопросы `addressee='owner'` со статусом `pending`. Сортировка по `deadline` (без срока — в конце), затем по дате создания. `inbox` форматирует тот же список блоками «просрочено / сегодня / висит» (`Q-28`).

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/questions.ts src/cli/commands tests/core/questions.test.ts
git commit -m "feat: questions, inbox and owner hand"
```

---

### Task 13: Block, попытки, needs_owner

**Files:**
- Modify: `src/core/lease.ts`, `src/core/tasks.ts`
- Create: `src/cli/commands/block.ts`, `src/cli/commands/done.ts`
- Test: `tests/core/block.test.ts`

**Interfaces:**
- Consumes: `ask(...)` из `Task 12`
- Produces: `blockTask(db, { taskId; executor; reason: 'needs_data'|'needs_access'|'needs_decision'|'impossible'|'budget_exceeded'|'preempted'; note: string }): Task`
- Produces: `doneTask(db, { taskId; executor; report: { summary: string; checks: string[]; left?: string } }): Task`
- Produces: `reopenTask(db, { taskId; actor; reason: string }): Task`

- [ ] **Step 1: Write the failing test**

```ts
test('block снимает задачу из руки и возвращает в пул', () => {
  const t = blockTask(db, { taskId: 'F1.S1-1', executor: 'w1', reason: 'needs_data', note: 'нет ключей' })
  assert.equal(t.status, 'blocked')
  assert.equal(getHand(db, 'w1').some(x => x.id === t.id), false)
})

test('needs_decision уходит владельцу, остальное — оркестратору', () => {
  const t = blockTask(db, { taskId: 'F1.S1-2', executor: 'w1', reason: 'needs_decision', note: 'макет?' })
  assert.ok(getQuestions(db, { addressee: 'owner' }).some(q => q.subjectId === t.id))
})

test('третья неудача переводит в needs_owner', () => {
  attempt(db, 'F1.S1-1'); attempt(db, 'F1.S1-1'); attempt(db, 'F1.S1-1')
  assert.equal(getTask(db, 'F1.S1-1').status, 'needs_owner')
})

test('done без отчёта отвергается', () => {
  assert.throws(() => doneTask(db, { taskId: 'F1.S1-1', executor: 'w1', report: { summary: '', checks: [] } }), /отчёт/)
})
```

- [ ] **Step 2: Run** `node --test tests/core/block.test.ts` → FAIL

- [ ] **Step 3: Implement**

`blockTask`: статус `blocked`, `holder=null`, из руки удаляется, событие. `needs_decision` создаёт вопрос адресату `owner`. Третья неудача (`attempts >= maxAttempts`) → `needs_owner` + вопрос. `doneTask`: только держатель, только `active`; статус `done` (в этом плане без git); `report.summary` обязателен.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core src/cli/commands tests/core/block.test.ts
git commit -m "feat: blocking with reasons, attempts and owner escalation"
```

---

### Task 14: `now` и `dispatch`

**Files:**
- Create: `src/core/views.ts`, `src/cli/commands/now.ts`, `src/cli/commands/dispatch.ts`
- Test: `tests/core/views.test.ts`

**Interfaces:**
- Produces: `nowView(db): { features: Array<{ id; name; stage: { id; seq; total; counts: Record<TaskStatus, number> }; }>; holders: Array<{ executor: string; task: string | null }>; waitingOwner: number }`
- Produces: `dispatchPlan(db): { assignments: Array<{ executor: string; tasks: string[]; newTask: string | null }>; warnings: string[] }`

- [ ] **Step 1: Write the failing test**

```ts
test('now показывает фичи, этапы и счётчики по статусам', () => {
  const v = nowView(db)
  assert.equal(v.features[0].stage.counts.active + v.features[0].stage.counts.ready + v.features[0].stage.counts.open, 3)
})

test('dispatch отдаёт только готовые задачи и порядок совпадает у двух вызовов', () => {
  assert.deepEqual(dispatchPlan(db), dispatchPlan(db))
})

test('задача с навыком, которого нет ни у кого, попадает в предупреждение', () => {
  const p = dispatchPlan(db)
  assert.ok(p.warnings.some(w => /audio/.test(w)))
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`nowView` — только чтение, без побочных эффектов; `dispatchPlan` вызывает `advanceTime`, заполняет руки в транзакции и возвращает решение. Ни один из них не пересчитывает порядок в другом месте — единственный источник `ordering.ts`.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/views.ts src/cli/commands tests/core/views.test.ts
git commit -m "feat: now and dispatch views"
```

---

### Task 15: `doctor`, JSON-полировка, документация команд

**Files:**
- Create: `src/cli/commands/doctor.ts`, `README.md`
- Modify: `src/cli/output.ts`
- Test: `tests/cli/doctor.test.ts`

**Interfaces:**
- Produces: `doctorReport(db): { checks: Array<{ name: string; ok: boolean; detail?: string }> }`
- Produces: единая функция `printJson(data: unknown)` — один объект, без префиксов

- [ ] **Step 1: Write the failing test**

```ts
test('doctor сообщает о незавершённой настройке', () => {
  const r = doctorReport(db)
  assert.ok(r.checks.some(c => c.name === 'исполнители' && !c.ok))
})

test('--json печатает ровно один JSON-объект', () => {
  const out = capture(() => ok({ a: 1 }, 'человеку'))
  assert.deepEqual(JSON.parse(out), { a: 1 })
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

Проверки `doctor`: есть конфиг, схема соответствует коду, есть хотя бы один исполнитель, есть задачи с навыками без исполнителя, есть `needs_owner` старше `ownerStaleDays`, есть `blocked` старше 3 дней, есть незакрытые вопросы без адресата, есть активная задача размера XS старше 15 минут (`Q-11`), фича ранга 1 не двигалась 3 дня (`Q-15`), журнал событий ссылается на несуществующие объекты (`D-10` — предупреждение, пересборка в этом плане не делается). `README.md` — список команд с примерами, без маркетинга.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli README.md tests/cli/doctor.test.ts
git commit -m "feat: doctor and json output polish"
```

---

## Что этот план сознательно не делает

- Не коммитит и не создаёт ветки — это план 2. `done` меняет только состояние.
- Не создаёт план из запроса (shaping) — это план 3. Здесь запросы, фичи, этапы и задачи создаются командами явно.
- Не содержит идей (`M-10`–`M-12`) и решений (`M-13`–`M-14`) — план 3.
- Не содержит рутин, календаря и тикера — план 4. Ленивые часы для аренды есть, расписания нет.
- Не пишет файлы для OpenCode — план 5.
- Не реализует `upgrade` и `version`-шимы — только `toolVersion` в конфиге, чтобы формат не пришлось менять.

## Проверка готовности плана 1

- [ ] `init` идемпотентен, повторный запуск не затирает конфиг
- [ ] Задача без DoD не создаётся, ошибка перечисляет поля
- [ ] Цикл зависимостей отвергается с путём
- [ ] Двое не берут одну задачу
- [ ] Истёкшая аренда возвращает задачу и засчитывает попытку
- [ ] Часы назад не воскрешают аренду
- [ ] Рука не зависает, когда все кандидаты заблокированы
- [ ] Порядок детерминирован: два вызова `dispatch` дают одно и то же
- [ ] Expedite вытесняет и пишет, что вытеснено
- [ ] Третья неудача уходит владельцу
- [ ] `now` показывает фичи, этапы и держателей без ручной сборки
- [ ] `doctor` находит незавершённую настройку
