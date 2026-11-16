# toolbox-al: рутины, гейты и календарь — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Повторяемая работа по расписанию: рутины с шагами, гейтами и прогонами, календарь и тикер, который двигает время без агента.

**Architecture:** Рутина — шаблон; прогон — её исполнение на конкретную дату. Время двигается лениво при каждом вызове CLI, тикер нужен только для механических шагов. Гейты — именованные условия трёх видов, проверяемые в момент запуска.

**Tech Stack:** Node 26, TypeScript без сборки, `node:sqlite`, `node:test`.

**Spec:** `docs/specs/2026-11-16-toolbox-al-design.md` (раздел 9; `C-1`–`C-27`)

## Global Constraints

- Node 26, TypeScript без сборки, ноль внешних зависимостей.
- Все мутации — в транзакции и с записью в `events`.
- Расписание — подмножество cron: `daily HH:MM`, `weekly 1,3,5 HH:MM`, `every Nd HH:MM`. Часовой пояс из конфига.
- Окно исполнения: запуск вне окна переносится на следующее окно и помечается опоздавшим.
- Механический шаг — команда без модели; агентский — задача.
- `approval`-гейт с `once` закрывается навсегда до `gate reset`.
- Три прогона подряд с заблокированным шагом дают одну эскалацию.
- Коды возврата: `0` успех, `1` нечего делать, `3` ошибка.

## Review Focus

1. **Тикер выключен.** Ожидание: рутины не идут, `doctor` предупреждает, остальное работает.
2. **Механический шаг падает.** Ожидание: прогон помечается частично выполненным, ошибка записана, остальные шаги не отменяются.
3. **Гейт `approval once` уже закрыт.** Ожидание: повторный прогон не спрашивает владельца.
4. **Три прогона подряд в блоке.** Ожидание: ровно одна эскалация.
5. **Запуск вне окна.** Ожидание: прогон переносится, а не выполняется сразу.

---

### Task 1: Схема v5

**Files:**
- Modify: `src/core/schema.ts`
- Test: `tests/core/schema5.test.ts`

**Interfaces:**
- Produces: `SCHEMA_VERSION = 5`
- Produces: таблицы `routines(id, name, schedule, window, timezone, guard, created_at)`, `routine_steps(id, routine_id, seq, title, kind, skill, command, dod, scope, on_missing, gate, created_at)`, `routine_runs(id, routine_id, due_at, status, started_at, finished_at, note)`, `gates(id, routine_id, step_id, kind, name, once, satisfied_at, payload)`

- [ ] **Step 1: Write the failing test**

```ts
test('схема v5 добавляет рутины, шаги, прогоны и гейты', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), 5)
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r: any) => r.name)
  for (const t of ['routines', 'routine_steps', 'routine_runs', 'gates']) assert.ok(tables.includes(t), t)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement migration v5**, обновить `SCHEMA_VERSION`, `Config.schemaVersion`, тесты версии.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: schema v5 for routines`

---

### Task 2: Расписание

**Files:**
- Create: `src/core/schedule.ts`
- Test: `tests/core/schedule.test.ts`

**Interfaces:**
- Produces: `parseSchedule(text: string): Schedule` — `{kind:'daily'|'weekly'|'every', time:{h,m}, days?: number[], everyDays?: number}`
- Produces: `nextRun(schedule: Schedule, from: Date): Date`
- Produces: `inWindow(window: string | null, at: Date): boolean` — `'HH:MM-HH:MM'`, переход через полночь разрешён

- [ ] **Step 1: Write the failing test**

```ts
test('daily считается на следующий день после времени', () => {
  const s = parseSchedule('daily 02:00')
  assert.equal(nextRun(s, new Date('2026-11-16T01:00:00')).toISOString(), '2026-11-16T02:00:00.000Z')
  assert.equal(nextRun(s, new Date('2026-11-16T03:00:00')).toISOString(), '2026-11-17T02:00:00.000Z')
})

test('weekly учитывает дни недели', () => {
  const s = parseSchedule('weekly 1,3 09:00')
  assert.equal(nextRun(s, new Date('2026-11-16T10:00:00')).getDay(), 3) // среда
})

test('every Nd сдвигает на N дней', () => {
  const s = parseSchedule('every 7d 09:00')
  assert.equal(nextRun(s, new Date('2026-11-16T10:00:00')).getDate(), 23)
})

test('окно переходит через полночь', () => {
  assert.equal(inWindow('22:00-04:00', new Date('2026-11-16T23:30:00')), true)
  assert.equal(inWindow('22:00-04:00', new Date('2026-11-16T12:00:00')), false)
})

test('мусор в расписании отвергается', () => {
  assert.throws(() => parseSchedule('когда-нибудь'), /расписан/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement** парсер и расчёт. Время — локальное, без DST-магии: считать через `Date` и локальные часы.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: schedule parsing and next run`

---

### Task 3: Рутины и шаги

**Files:**
- Create: `src/core/routines.ts`, `src/cli/commands/routine.ts`
- Test: `tests/core/routines.test.ts`

**Interfaces:**
- Produces: `addRoutine(db, { name, schedule, window?, timezone?, guard? }): Routine`
- Produces: `addStep(db, { routineId, title, kind: 'agent'|'mechanical', skill?, command?, dod?, scope?, onMissing?, gate? }): RoutineStep`
- Produces: `listRoutines(db)`, `getRoutine(db, id)`, `listSteps(db, routineId)`

- [ ] **Step 1: Write the failing test**

```ts
test('рутина с агентским и механическим шагом', () => {
  const routine = addRoutine(db, { name: 'Пинтерест', schedule: 'every 7d 09:00' })
  const agent = addStep(db, { routineId: routine.id, title: 'Сделать контент', kind: 'agent', skill: 'content', dod: ['7 постов'], scope: ['content/**'] })
  const mechanical = addStep(db, { routineId: routine.id, title: 'Залить', kind: 'mechanical', command: 'echo ok' })

  assert.equal(agent.seq, 1)
  assert.equal(mechanical.seq, 2)
  assert.equal(listSteps(db, routine.id).length, 2)
})

test('агентский шаг требует навык и DoD', () => {
  assert.throws(() => addStep(db, { routineId: routine.id, title: 'x', kind: 'agent' }), /навык/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: routines and steps`

---

### Task 4: Материализация прогонов

**Files:**
- Create: `src/core/runs.ts`
- Test: `tests/core/runs.test.ts`

**Interfaces:**
- Produces: `materialize(db, { now? }): RoutineRun[]` — создаёт прогоны на `due_at` в пределах `leadHours` (по умолчанию 24)
- Produces: `listRuns(db, { from?, to? }): RoutineRun[]`
- Правила: один прогон на `(routine_id, due_at)`, повторный вызов не дублирует

- [ ] **Step 1: Write the failing test**

```ts
test('прогон материализуется заранее и не дублируется', () => {
  const now = new Date('2026-11-16T00:00:00')
  const runs = materialize(db, { now })
  assert.equal(runs.length, 1)
  assert.equal(materialize(db, { now }).length, 0)
})

test('прогон не создаётся раньше окна материализации', () => {
  const now = new Date('2026-11-18T00:00:00')
  assert.equal(materialize(db, { now }).length, 1)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: routine run materialization`

---

### Task 5: Гейты

**Files:**
- Create: `src/core/gates.ts`
- Test: `tests/core/gates.test.ts`

**Interfaces:**
- Produces: `addGate(db, { routineId, stepId?, kind: 'capability'|'check'|'approval', name, once?, payload? })`
- Produces: `checkGate(db, gate, { root }): { ok: boolean; reason?: string }`
- Правила: `capability` — фича/этап в `merged`; `check` — команда вернула 0; `approval` — есть одобрение (закрыт `satisfied_at`)

- [ ] **Step 1: Write the failing test**

```ts
test('capability-гейт ждёт слияния этапа', () => {
  const gate = addGate(db, { routineId, kind: 'capability', name: 'F1.S1' })
  assert.equal(checkGate(db, gate, { root }).ok, false)
  db.prepare("update stages set status = 'merged' where id = 'F1.S1'").run()
  assert.equal(checkGate(db, gate, { root }).ok, true)
})

test('check-гейт запускает команду', () => {
  const gate = addGate(db, { routineId, kind: 'check', name: 'ok', payload: 'git rev-parse --verify refs/heads/main' })
  assert.equal(checkGate(db, gate, { root }).ok, true)
})

test('approval once закрывается навсегда', () => {
  const gate = addGate(db, { routineId, kind: 'approval', name: 'first_publish', once: true })
  assert.equal(checkGate(db, gate, { root }).ok, false)
  satisfyGate(db, { gateId: gate.id, actor: 'owner' })
  assert.equal(checkGate(db, getGate(db, gate.id)!, { root }).ok, true)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: routine gates`

---

### Task 6: Исполнение прогона

**Files:**
- Create: `src/core/execute.ts`
- Test: `tests/core/execute.test.ts`

**Interfaces:**
- Produces: `executeRun(db, { runId, root, now? }): { status: 'done'|'partial'|'waiting_gate'|'skipped'; steps: Array<{ step: RoutineStep; result: string }> }`
- Правила: гейты проверяются до шага; механический шаг выполняется через `cmd /c`; агентский создаёт задачу; `on_missing` при невыполненном гейте; падение команды → `partial`

- [ ] **Step 1: Write the failing test**

```ts
test('механический шаг выполняется и пишет результат', () => {
  const run = runWith([{ kind: 'mechanical', command: 'echo привет' }])
  const result = executeRun(db, { runId: run.id, root })
  assert.equal(result.status, 'done')
  assert.match(result.steps[0].result, /привет/)
})

test('падение команды делает прогон частичным', () => {
  const run = runWith([{ kind: 'mechanical', command: 'git rev-parse --verify refs/heads/nope' }])
  const result = executeRun(db, { runId: run.id, root })
  assert.equal(result.status, 'partial')
  assert.ok(result.steps[0].result.length > 0)
})

test('невыполненный approval-гейт держит шаг', () => {
  const run = runWith([{ kind: 'agent', gate: 'first' }])
  const result = executeRun(db, { runId: run.id, root })
  assert.equal(result.status, 'waiting_gate')
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: routine run execution`

---

### Task 7: Тикер, эскалация и календарь

**Files:**
- Create: `src/core/tick.ts`, `src/cli/commands/tick.ts`, `src/cli/commands/cal.ts`
- Modify: `src/core/clock.ts`, `src/core/doctor.ts`, `src/cli/commands/scheduler.ts`
- Test: `tests/core/tick.test.ts`

**Interfaces:**
- Produces: `tick(db, { root, now? }): { materialized: number; executed: string[]; escalated: string[] }`
- Производит: `scheduler enable|disable|status` — Windows `schtasks`, по умолчанию выключен
- Производит: `cal(db, { days }): Array<{ at: string; kind: string; title: string; detail?: string }>`
- Правила: три прогона подряд с `waiting_gate` → одна эскалация (вопрос владельцу), дальше молчание

- [ ] **Step 1: Write the failing test**

```ts
test('tick материализует и исполняет механику', () => {
  const result = tick(db, { root, now })
  assert.equal(result.materialized, 1)
  assert.equal(result.executed.length, 1)
})

test('три прогона в блоке дают одну эскалацию', () => {
  for (const day of ['2026-11-16', '2026-11-17', '2026-11-18']) tick(db, { root, now: new Date(`${day}T10:00:00`) })
  const questions = getQuestions(db, { addressee: 'owner' }).filter((q) => q.text.includes('рутина'))
  assert.equal(questions.length, 1)
})

test('cal показывает прогоны и сроки', () => {
  assert.ok(cal(db, { days: 7 }).some((item) => item.kind === 'routine'))
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: ticker, escalation and calendar`

---

### Task 8: `friction` и документация

**Files:**
- Create: `src/core/friction.ts`, `src/cli/commands/friction.ts`
- Modify: `README.md`
- Test: `tests/core/friction.test.ts`

**Interfaces:**
- Produces: `frictionReport(db, { days }): Array<{ name: string; value: number; hint: string }>`
- Метрики: доля expedite, переоткрытия, `attempts_exhausted`, возраст `blocked`, прогоны в блоке
- `doctor`: предупреждение при выключенном тикере и наличии рутин

- [ ] **Step 1: Write the failing test**

```ts
test('friction считает долю срочного', () => {
  const report = frictionReport(db, { days: 7 })
  assert.ok(report.some((item) => item.name === 'доля срочного'))
})

test('doctor предупреждает про выключенный тикер', () => {
  // есть рутина, тикер не включён
  const report = doctorReport(db, { root })
  assert.ok(report.checks.some((c) => c.name === 'тикер' && !c.ok))
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: friction report and routine docs`

---

## Что этот план сознательно не делает

- Не запускает агентов: агентский шаг создаёт задачу, работу берёт исполнитель.
- Не гарантирует точный запуск в секунду: окно и следующий тик.
- Не делает сетевой календарь и внешние напоминания.

## Проверка готовности плана 4

- [ ] Расписание разбирается, включая окно через полночь
- [ ] Прогоны не дублируются и материализуются заранее
- [ ] Гейты трёх видов работают, `approval once` закрывается навсегда
- [ ] Механический шаг падает → прогон частичный, ошибка записана
- [ ] Тикер идемпотентен
- [ ] Эскалация одна на три прогона
- [ ] `cal` показывает прогоны и сроки
- [ ] `friction` считает сигналы, `doctor` предупреждает про тикер
