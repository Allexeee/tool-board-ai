# toolbox-al: shaping, ревью и шаблоны — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Запрос превращается в версионируемый план из явных шагов и применяется одной командой; задачи проходят ревью и приёмку; повторяемая работа описывается шаблонами.

**Architecture:** План — неизменяемая запись с JSON-шагами и номером версии; применение плана — одна транзакция, создающая фичу, этапы и задачи. Ревью — вердикт отдельной сущностью, без аренды и руки. Идеи, решения и шаблоны — тонкие таблицы и файлы, читаемые в контексте задачи.

**Tech Stack:** Node 26, TypeScript без сборки, `node:sqlite`, `node:test`.

**Spec:** `docs/specs/2026-11-16-toolbox-al-design.md` (разделы 3.7–3.9, 4.1, 8; `M-10`–`M-17`, `M-25`–`M-29`, `M-33`–`M-43`, `V-1`–`V-9`)

## Global Constraints

- Node 26, TypeScript без сборки, ноль внешних зависимостей.
- Все мутации — в транзакции и с записью в `events`.
- План неизменяем: правка — новая версия, старая остаётся.
- `plan apply` отказывается, если шаг неполон: нужны `title`, `skill`, `size`, `dod`, `scope`.
- Размер шага не больше `M`; `XL` отвергается.
- Ревью не занимает руку, аренду и WIP-слот.
- Коды возврата: `0` успех, `1` нечего делать, `3` ошибка.

## Review Focus

1. **План с неполным шагом.** Ожидание: `plan apply` отказывает и перечисляет, чего не хватает; ни фича, ни задачи не создаются.
2. **Повторное применение того же плана.** Ожидание: отказ «уже применён», без дублей фич и задач.
3. **Ревью своей же задачи.** Ожидание: отказ; автор не ревьюит себя.
4. **Приёмка этапа без правки merge.** Ожидание: этап с `acceptance='owner'` не сливается, пока не принят.
5. **Шаблон из несуществующей фичи.** Ожидание: понятная ошибка, пустой файл не создаётся.

## Фикстуры тестов

- `stagesFixture` — один этап с двумя полными шагами (backend S, frontend S), без `deps`.
- `planWith({ steps })` — запрос + план, собранный из переданных шагов.
- `readyForReview({ review })` — исполнитель w1, задача взята и закрыта через `doneTask` (значит `in_review`), возвращает `{ db, task }`.
- `featureWithStages(db)` — фича «Оплата» с этапом «Каркас» и одной задачей.

---

### Task 1: Схема v4

**Files:**
- Modify: `src/core/schema.ts`, `src/core/tasks.ts`
- Test: `tests/core/schema4.test.ts`

**Interfaces:**
- Produces: `SCHEMA_VERSION = 4`
- Produces: таблицы `ideas(id, text, source, review_at, promoted_to, created_at)`, `decisions(id, question, choice, alternatives, reason, subject_id, author, created_at)`, `plans(id, request_id, version, title, assumptions, steps, approved_at, approved_by, applied_at, feature_id, created_at)`
- Produces: `tasks.review text not null default 'agent'`
- Produces: `Task.review: 'none'|'agent'|'owner'`

- [ ] **Step 1: Write the failing test**

```ts
test('схема v4 добавляет идеи, решения, планы и review у задачи', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), 4)
  const tables = db.prepare("select name from sqlite_master where type='table'").all().map((r: any) => r.name)
  for (const t of ['ideas', 'decisions', 'plans']) assert.ok(tables.includes(t), t)
  const cols = db.prepare('pragma table_info(tasks)').all().map((c: any) => c.name)
  assert.ok(cols.includes('review'))
})
```

- [ ] **Step 2: Run** `node --test tests/core/schema4.test.ts` → FAIL

- [ ] **Step 3: Implement migration v4**

`if (from < 4)` — `create table` для трёх таблиц, `alter table tasks add column review text not null default 'agent'`. Обновить `SCHEMA_VERSION`, `Config.schemaVersion`, тест версии в `db.test.ts` на 4.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: schema v4 for plans, ideas, decisions and review`

---

### Task 2: Идеи

**Files:**
- Create: `src/core/ideas.ts`, `src/cli/commands/idea.ts`
- Test: `tests/core/ideas.test.ts`

**Interfaces:**
- Produces: `addIdea(db, { text, source?, reviewAt? }): Idea`
- Produces: `listIdeas(db): Idea[]`
- Produces: `promoteIdea(db, { ideaId, author }): { idea: Idea; request: Request }` — создаёт запрос, пишет `promoted_to`
- Produces: `staleIdeas(db, days = 30): Idea[]`

- [ ] **Step 1: Write the failing test**

```ts
test('идея повышается до запроса один раз', () => {
  const db = openDb(':memory:')
  const idea = addIdea(db, { text: 'экспорт в CSV' })
  const { request } = promoteIdea(db, { ideaId: idea.id, author: 'owner' })
  assert.equal(request.title, 'экспорт в CSV')
  assert.throws(() => promoteIdea(db, { ideaId: idea.id, author: 'owner' }), /уже/)
})

test('идея без даты пересмотра попадает в забытые', () => {
  const db = openDb(':memory:')
  addIdea(db, { text: 'старая идея' })
  assert.equal(staleIdeas(db, 0).length, 1)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`source` по умолчанию `owner`. `reviewAt` по умолчанию `null`. `staleIdeas` — идеи без `promoted_to`, у которых `review_at` пуст или старше `days`.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: ideas with promotion to request`

---

### Task 3: Решения

**Files:**
- Create: `src/core/decisions.ts`, `src/cli/commands/decide.ts`
- Test: `tests/core/decisions.test.ts`

**Interfaces:**
- Produces: `addDecision(db, { question, choice, alternatives?, reason, subjectId?, author }): Decision`
- Produces: `listDecisions(db, filter?: { subjectId?: string }): Decision[]`

- [ ] **Step 1: Write the failing test**

```ts
test('решение хранит альтернативы и связь с фичей', () => {
  const db = openDb(':memory:')
  const decision = addDecision(db, {
    question: 'какой провайдер',
    choice: 'ЮKassa',
    alternatives: ['Stripe'],
    reason: 'у клиента договор',
    subjectId: 'F1',
    author: 'owner',
  })
  assert.deepEqual(decision.alternatives, ['Stripe'])
  assert.equal(listDecisions(db, { subjectId: 'F1' })[0].id, decision.id)
  assert.equal(listDecisions(db, { subjectId: 'F2' }).length, 0)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`alternatives` — JSON-массив. `subjectId` необязателен.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: decisions log`

---

### Task 4: План и версии

**Files:**
- Create: `src/core/plans.ts`
- Test: `tests/core/plans.test.ts`

**Interfaces:**
- Produces: `addPlan(db, { requestId, title, assumptions, stages }): Plan` — версия = предыдущая + 1
- Produces: `getPlan(db, { requestId, version? }): Plan | null` — без версии возвращает последнюю
- Produces: `approvePlan(db, { requestId, version, actor }): Plan`
- Produces: `type PlanStage = { name: string; goal: string; appetite: string; steps: PlanStep[] }`
- Produces: `type PlanStep = { title: string; skill: string; size: 'XS'|'S'|'M'|'L'; dod: string[]; scope: string[]; deps?: number[] }`

- [ ] **Step 1: Write the failing test**

```ts
test('версии плана растут, старая остаётся неизменной', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  const v1 = addPlan(db, { requestId: request.id, title: 'Оплата', assumptions: ['карты'], stages: stagesFixture })
  const v2 = addPlan(db, { requestId: request.id, title: 'Оплата', assumptions: [], stages: stagesFixture })

  assert.equal(v1.version, 1)
  assert.equal(v2.version, 2)
  assert.deepEqual(getPlan(db, { requestId: request.id, version: 1 })!.assumptions, ['карты'])
  assert.equal(getPlan(db, { requestId: request.id })!.version, 2)
})

test('утверждённый план фиксирует автора и время', () => {
  const plan = approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })
  assert.ok(plan.approvedAt)
  assert.equal(plan.approvedBy, 'owner')
  assert.throws(() => approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' }), /уже/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`steps` и `assumptions` хранятся JSON. `approvePlan` пишет `approved_at`/`approved_by` и событие. Версия считается по `max(version)` для запроса.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: versioned plans`

---

### Task 5: Применение плана

**Files:**
- Create: `src/core/apply.ts`, `src/cli/commands/plan.ts`
- Test: `tests/core/apply.test.ts`

**Interfaces:**
- Produces: `validatePlan(plan: Plan): string[]` — пустой массив, если всё в порядке
- Produces: `applyPlan(db, { requestId, version?, actor }): { feature: Feature; stages: Stage[]; tasks: Task[] }`
- Правила: план утверждён; шаг полный; `size` не `XL`; `L` только с причиной не поддерживается в плане — значит `L` запрещён; `deps` — индексы шагов внутри этапа

- [ ] **Step 1: Write the failing test**

```ts
test('неполный шаг не даёт применить план', () => {
  const plan = planWith({ steps: [{ title: 'Оплата', skill: 'backend', size: 'S', dod: [], scope: [] }] })
  assert.match(validatePlan(plan).join('\n'), /DoD/)
  assert.throws(() => applyPlan(db, { requestId }), /неполн|DoD/)
  assert.equal(listFeatures(db).length, 0)
})

test('применённый план создаёт фичу, этап и задачи', () => {
  const result = applyPlan(db, { requestId })
  assert.equal(result.feature.name, 'Оплата')
  assert.equal(result.stages.length, 1)
  assert.equal(result.tasks.length, 2)
  assert.equal(getRequest(db, requestId)!.status, 'planned')
})

test('второй apply отвергается', () => {
  applyPlan(db, { requestId })
  assert.throws(() => applyPlan(db, { requestId }), /уже примен/)
})

test('XL в плане отвергается', () => {
  const plan = planWith({ steps: [{ ...step, size: 'XL' }] })
  assert.match(validatePlan(plan).join(' '), /XL/)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`applyPlan` в одной транзакции: создать фичу от плана, этапы по порядку, задачи с `dod`/`scope`/`skill`/`size`; `deps` — по индексам соседних шагов, через `addDep`. Активировать первый этап. Записать `plans.applied_at` и `feature_id`. Изменения откатываются при любой ошибке.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: plan validation and atomic apply`

---

### Task 6: Ревью

**Files:**
- Create: `src/core/reviews.ts`, `src/cli/commands/review.ts`
- Modify: `src/core/done.ts`, `src/core/questions.ts`
- Test: `tests/core/reviews.test.ts`

**Interfaces:**
- Produces: `submitReview(db, { taskId, reviewer, verdict: 'approved'|'rejected', note? }): Review`
- Правила: задача в `in_review`; ревьюер не исполнитель; `rejected` требует `note`; `approved` закрывает задачу в `done`, `rejected` возвращает в `ready` и пишет причину
- Изменяет: `doneTask` ставит `in_review`, если `task.review != 'none'`
- Изменяет: `ownerHand` включает задачи `in_review` с `review='owner'`

- [ ] **Step 1: Write the failing test**

```ts
test('агентское ревью закрывает задачу', () => {
  const { db, task } = readyForReview()
  const review = submitReview(db, { taskId: task.id, reviewer: 'w2', verdict: 'approved' })
  assert.equal(review.verdict, 'approved')
  assert.equal(getTask(db, task.id)!.status, 'done')
})

test('свою задачу ревьюить нельзя', () => {
  assert.throws(() => submitReview(db, { taskId: task.id, reviewer: 'w1', verdict: 'approved' }), /свою/)
})

test('отклонение требует причины и возвращает в работу', () => {
  assert.throws(() => submitReview(db, { taskId: task.id, reviewer: 'w2', verdict: 'rejected' }), /причин/)
  submitReview(db, { taskId: task.id, reviewer: 'w2', verdict: 'rejected', note: 'нет теста' })
  assert.equal(getTask(db, task.id)!.status, 'ready')
})

test('задача с review=owner ждёт владельца в руке', () => {
  const { db, task } = readyForReview({ review: 'owner' })
  assert.ok(ownerHand(db).some((item) => item.id === task.id))
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`doneTask` пишет `in_review` при `review != 'none'`, иначе `done`. `submitReview` в транзакции: проверки, запись в `reviews`, смена статуса, событие.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: task reviews with verdicts`

---

### Task 7: Приёмка этапа

**Files:**
- Create: `src/core/accept.ts`, `src/cli/commands/stage.ts` (подкоманды `accept`, `reject`)
- Modify: `src/core/git/merge.ts`
- Test: `tests/core/accept.test.ts`

**Interfaces:**
- Produces: `acceptStage(db, { stageId, actor }): Stage` — `status='accepted'`
- Produces: `rejectStage(db, { stageId, actor, reason }): Stage` — `status='active'`, задачи `in_review` → `ready`
- Изменяет: `mergeStage` отказывает, если `stage.acceptance === 'owner'` и `status !== 'accepted'`

- [ ] **Step 1: Write the failing test**

```ts
test('этап с приёмкой владельца не сливается без приёмки', () => {
  const { db, root, config, stage } = mergedReadyFixture({ acceptance: 'owner' })
  const result = mergeStage(db, { root, stageId: stage.id, config })
  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /принят/)

  acceptStage(db, { stageId: stage.id, actor: 'owner' })
  assert.equal(mergeStage(db, { root, stageId: stage.id, config }).merged, true)
})

test('возврат этапа переоткрывает задачи', () => {
  // задача in_review → rejectStage → ready
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

`mergedReadyFixture` расширяется опцией `acceptance`. `acceptStage` требует `status === 'in_review'` или `active`. `rejectStage` возвращает `active` и событие.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: stage acceptance gate`

---

### Task 8: Шаблоны и похожие фичи

**Files:**
- Create: `src/core/templates.ts`, `src/cli/commands/template.ts`
- Test: `tests/core/templates.test.ts`

**Interfaces:**
- Produces: `saveTemplate(root, { name, featureId, db }): string` — путь файла
- Produces: `listTemplates(root): string[]`
- Produces: `showTemplate(root, name): string`
- Produces: `similarFeatures(db, query: string): Feature[]` — совпадение по словам в имени, до 5
- Правила: имя только `[a-z0-9-]`; шаблон — markdown со списком этапов и шагов; из несуществующей фичи — ошибка

- [ ] **Step 1: Write the failing test**

```ts
test('шаблон сохраняется из фичи и читается', () => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-'))
  const db = openDb(':memory:')
  const feature = featureWithStages(db)
  const path = saveTemplate(root, { name: 'content-pack', featureId: feature.id, db })
  assert.ok(existsSync(path))
  assert.match(showTemplate(root, 'content-pack'), /Каркас/)
  assert.deepEqual(listTemplates(root), ['content-pack'])
})

test('имя шаблона проверяется', () => {
  assert.throws(() => saveTemplate(root, { name: 'Плохое имя', featureId, db }), /имя/)
})

test('похожие фичи находятся по словам', () => {
  assert.equal(similarFeatures(db, 'оплата')[0].id, feature.id)
})
```

- [ ] **Step 2: Run** → FAIL

- [ ] **Step 3: Implement**

Каталог `.toolbox-al/templates/`. Markdown: `# name`, `## Этап`, список `- [skill, size] title — DoD`. `similarFeatures` — пересечение слов в нижнем регистре.

- [ ] **Step 4: Run** → PASS

- [ ] **Step 5: Commit** `feat: templates and similar features`

---

## Что этот план сознательно не делает

- Не создаёт план из свободного текста: план собирает агент, CLI его принимает и проверяет.
- Не сравнивает план с фактом после закрытия фичи (`M-42`) — это план 4 вместе с метриками.
- Не добавляет решения в `task show` (`M-14`) — только хранит и перечисляет.

## Проверка готовности плана 3

- [ ] Версии плана неизменяемы, утверждение фиксируется
- [ ] Неполный шаг не даёт применить план, ничего не создаётся
- [ ] Повторное применение отвергается
- [ ] Ревью не даёт закрыть задачу автору
- [ ] Отклонение требует причины и возвращает задачу в работу
- [ ] Этап с приёмкой владельца не сливается без приёмки
- [ ] Шаблон сохраняется и читается, имя проверяется
- [ ] Похожие фичи находятся по словам
