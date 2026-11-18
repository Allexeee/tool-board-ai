import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { addRequest, openRequests } from '../../src/core/requests.ts'
import { addFeature, setFeatureBranch } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor, clearBusy, setBusy } from '../../src/core/executors.ts'
import { setHand } from '../../src/core/hands.ts'
import { addDep } from '../../src/core/deps.ts'
import { takeTask } from '../../src/core/lease.ts'
import { doneTask } from '../../src/core/done.ts'
import { endRun, startRun } from '../../src/core/runs.ts'
import { collectRunReport, renderRunReport } from '../../src/core/run-report.ts'
import { readLiveSessions, type LiveSession, type LiveTool } from '../../src/core/usage.ts'
import { nowView, dispatchPlan, ownerView, taskQueue, queueFreeReason, assignmentStats } from '../../src/core/views.ts'

function seed(db: DatabaseSync): string {
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  setFeatureBranch(db, feature.id, 'feat/test', 'C:/tmp/test-worktree')
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  const base = {
    stageId: stage.id,
    dod: ['a'],
    size: 'S' as const,
    skill: 'backend',
    class: 'standard' as const,
    scope: ['src/**'],
  }
  createTask(db, { ...base, title: 'Первый шаг' })
  createTask(db, { ...base, title: 'Второй шаг' })
  createTask(db, { ...base, title: 'Третий шаг' })
  refreshReady(db)
  return stage.id
}

test('now показывает фичи, этапы и счётчики по статусам', () => {
  const db = openDb(':memory:')
  seed(db)
  const view = nowView(db)
  const counts = view.features[0].stage.counts
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), 3)
})

test('единственный запрос с закрытой фичей не считается открытым', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  db.prepare("update features set status = 'done' where id = ?").run(feature.id)

  assert.deepEqual(nowView(db).requests, [], 'в now запрос закрыт по фиче')
  assert.deepEqual(openRequests(db), [], 'в request open тот же ответ')
})

test('now и request open считают открытые запросы одинаково', () => {
  const db = openDb(':memory:')
  const closed = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: closed.id, name: 'A', rank: 1 })
  db.prepare("update features set status = 'done' where id = ?").run(feature.id)
  const open = addRequest(db, { title: 'Доставка', body: '...', author: 'owner' })

  const view = nowView(db)
  assert.deepEqual(view.requests, [{ id: open.id, title: 'Доставка' }])
  assert.deepEqual(
    openRequests(db).map((request) => request.id),
    [open.id],
  )
  assert.equal(view.requests.length, openRequests(db).length, 'счётчики совпадают')
})

test('dispatch отдаёт только готовые задачи и порядок совпадает у двух вызовов', () => {
  const db = openDb(':memory:')
  seed(db)
  assert.deepEqual(dispatchPlan(db), dispatchPlan(db))
})

test('навык без исполнителя попадает в предупреждение', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  createTask(db, {
    stageId,
    title: 'Записать выстрелы',
    dod: ['a'],
    size: 'S',
    skill: 'audio',
    class: 'standard',
    scope: ['assets/**'],
  })
  refreshReady(db)

  const plan = dispatchPlan(db)
  assert.ok(plan.warnings.some((warning) => warning.includes('audio')))
})

test('повторный dispatch не сбрасывает руки', () => {
  const db = openDb(':memory:')
  seed(db)
  const first = dispatchPlan(db)
  const second = dispatchPlan(db)
  assert.deepEqual(second.assignments, first.assignments)
  assert.ok(second.assignments[0].tasks.length > 0)
})

test('у завершённой фичи прогресс полный, а не первый этап', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update stages set status = 'merged' where id = ?").run(stageId)
  db.prepare("update features set status = 'done' where id = 'F1'").run()

  const feature = nowView(db, { all: true }).features[0]
  assert.equal(feature.finished, true)
  assert.equal(feature.stage.done, 1)
  assert.equal(feature.stage.seq, feature.stage.total)
})

test('номер этапа считается по завершённым', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addStage(db, { featureId: 'F1', name: 'S2', goal: 'g', appetite: '1 день' })
  db.prepare("update stages set status = 'merged' where id = ?").run(stageId)
  activateNextStage(db, 'F1')

  const feature = nowView(db).features[0]
  assert.equal(feature.stage.total, 2)
  assert.equal(feature.stage.seq, 2)
  assert.equal(feature.stage.done, 1)
})

test('now по умолчанию не показывает завершённые фичи, а с all показывает', () => {
  const db = openDb(':memory:')
  seed(db)
  db.prepare("update features set status = 'done' where id = 'F1'").run()

  assert.deepEqual(nowView(db).features, [])
  assert.equal(nowView(db, { all: true }).features.length, 1)
})

test('ready-задача пула видна в now отдельной строкой', () => {
  const db = openDb(':memory:')
  seed(db)
  createTask(db, {
    title: 'Поправить опечатку',
    dod: ['опечатки нет'],
    size: 'XS',
    skill: 'backend',
    class: 'quick',
    scope: ['docs/**'],
  })
  refreshReady(db)

  assert.ok(nowView(db).pool.some((task) => task.title === 'Поправить опечатку'))
})

test('owner строит одну строку на фичу, а не на этап', () => {
  const db = openDb(':memory:')
  seed(db)
  addStage(db, { featureId: 'F1', name: 'S2', goal: 'g', appetite: '1 день' })

  const rows = ownerView(db).stages
  assert.equal(rows.length, 1, 'этапы не размножают строки')

  const [row] = rows
  assert.equal(row.featureId, 'F1')
  assert.equal(row.featureName, 'A')
  assert.equal(row.name, 'A', 'в строке имя фичи')
  assert.equal(row.status, 'pending')
  assert.deepEqual(row.progress, { current: 0, total: 3 }, 'прогресс по задачам всей фичи')
})

test('owner считает прогресс по закрытым задачам фичи', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update tasks set status = 'done' where id = ?").run(`${stageId}-1`)
  db.prepare("update tasks set status = 'done' where id = ?").run(`${stageId}-2`)

  const row = ownerView(db).stages[0]
  assert.deepEqual(row.progress, { current: 2, total: 3 })
})

test('owner различает не начатый, идущий и готовый к слиянию этап', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  assert.equal(ownerView(db).stages[0].status, 'pending', 'нет движения — не работа')

  const first = `${stageId}-1`
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = ?").run(first)
  assert.equal(ownerView(db).stages[0].status, 'wip')

  db.prepare("update tasks set status = 'done' where stage_id = ?").run(stageId)
  assert.equal(ownerView(db).stages[0].status, 'merge', 'все задачи закрыты, но в dev не слито')

  db.prepare("update stages set status = 'merged' where id = ?").run(stageId)
  assert.equal(ownerView(db).stages[0].status, 'done')
})

test('фича со всеми слитыми этапами идёт одной строкой', () => {
  const db = openDb(':memory:')
  seed(db)
  addStage(db, { featureId: 'F1', name: 'S2', goal: 'g', appetite: '1 день' })
  db.prepare("update tasks set status = 'done'").run()
  db.prepare("update stages set status = 'merged'").run()

  const rows = ownerView(db).stages

  assert.equal(rows.length, 1, 'этапы слитой фичи схлопываются в строку фичи')
  assert.equal(rows[0].featureId, 'F1')
  assert.equal(rows[0].name, 'A')
  assert.equal(rows[0].status, 'done')
  assert.deepEqual(rows[0].progress, { current: 3, total: 3 })
})

test('owner сортирует этапы: готовые, затем в работе, затем очередь', () => {
  const db = openDb(':memory:')
  seed(db)

  const done = addFeature(db, { name: 'B', rank: 2 })
  addStage(db, { featureId: done.id, name: 'B1', goal: 'g', appetite: '1 день' })
  db.prepare("update stages set status = 'merged' where feature_id = ?").run(done.id)

  const queued = addFeature(db, { name: 'C', rank: 3 })
  addStage(db, { featureId: queued.id, name: 'C1', goal: 'g', appetite: '1 день' })

  const working = addFeature(db, { name: 'D', rank: 4 })
  const workingStage = addStage(db, { featureId: working.id, name: 'D1', goal: 'g', appetite: '1 день' })
  db.prepare("update stages set status = 'active' where feature_id = ?").run(working.id)
  createTask(db, {
    stageId: workingStage.id,
    title: 'В работе',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  db.prepare("update tasks set status = 'active', holder = 'w1' where stage_id = ?").run(workingStage.id)

  assert.deepEqual(
    ownerView(db).stages.map((row) => row.stageId),
    [`${done.id}.S1`, `${working.id}.S1`, 'F1.S1', `${queued.id}.S1`],
  )
})

test('owner без all не показывает завершённые и отменённые фичи', () => {
  const db = openDb(':memory:')
  seed(db)
  db.prepare("update features set status = 'done' where id = 'F1'").run()

  const cancelled = addFeature(db, { name: 'B', rank: 2 })
  addStage(db, { featureId: cancelled.id, name: 'B1', goal: 'g', appetite: '1 день' })
  db.prepare("update features set status = 'cancelled' where id = ?").run(cancelled.id)

  assert.deepEqual(ownerView(db).stages, [])
  assert.equal(ownerView(db, { all: true }).stages.length, 2)
})

test('now отдаёт занятость рядом с рукой', () => {
  const db = openDb(':memory:')
  seed(db)
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w3', kind: 'agent', skills: ['design'] })

  const busy = setBusy(db, { executorId: 'w1', reason: 'разбор F41', until: '30m', actor: 'w1' })

  const holders = nowView(db).holders
  assert.deepEqual(holders.find((holder) => holder.executor === 'w1')!.busy, {
    reason: 'разбор F41',
    until: busy.until,
  })

  // у двух других занятости нет: строка говорит «свободен», а не падает
  assert.equal(holders.find((holder) => holder.executor === 'w2')!.busy, null)
  assert.equal(holders.find((holder) => holder.executor === 'w3')!.busy, null)
})

test('строка исполнителя: работает над задачей, ждёт причину или отдыхает', () => {
  const db = openDb(':memory:')
  seed(db)
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w3', kind: 'agent', skills: ['backend'] })

  const first = db.prepare('select id, title from tasks order by id limit 1').get() as {
    id: string
    title: string
  }

  // w1 работает: задача у него в руках
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = ?").run(first.id)
  // w2 не берёт работу: владелец занял его разбором
  setBusy(db, { executorId: 'w2', reason: 'разбор F41', until: '30m', actor: 'owner' })

  const by = (id: string) => nowView(db).holders.find((holder) => holder.executor === id)!

  assert.deepEqual(by('w1').state, { kind: 'work', taskId: first.id, title: first.title })

  const wait = by('w2').state
  assert.equal(wait.kind, 'wait')
  if (wait.kind === 'wait') assert.equal(wait.reason, 'разбор F41')

  assert.deepEqual(by('w3').state, { kind: 'rest' }, 'ничего нет — отдыхает')
})

test('задача в руке без блокировки — резерв со всеми задачами, а не выдуманная работа', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const base = {
    dod: ['a'],
    size: 'S' as const,
    skill: 'backend',
    class: 'standard' as const,
    scope: ['src/**'],
  }
  const first = createTask(db, { ...base, title: 'Блокер' })
  const second = createTask(db, { ...base, title: 'Зависимая' })
  addDep(db, second.id, first.id)
  refreshReady(db)
  // цепочка в руке: зависимая ждёт блокера, который тоже лежит в руке
  setHand(db, 'w1', [first.id, second.id], 'owner')

  const state = nowView(db).holders.find((holder) => holder.executor === 'w1')!.state
  assert.equal(state.kind, 'reserved')
  if (state.kind === 'reserved') {
    assert.deepEqual(state.taskIds, [first.id, second.id], 'видны все задачи руки, а не первая')
    assert.match(state.reason ?? '', new RegExp(first.id.replace('.', '\\.')), 'причина называет блокера')
  }
})

test('исполнитель без связи — «нет связи», а не отдых', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const state = (sessions: LiveSession[] = []) =>
    nowView(db, { sessions }).holders.find((holder) => holder.executor === 'w1')!.state
  const setSeen = (agoMs: number) =>
    db
      .prepare('update executors set last_seen = ? where id = ?')
      .run(new Date(Date.now() - agoMs).toISOString(), 'w1')

  setSeen(5 * 60 * 60_000)
  const offline = state()
  assert.equal(offline.kind, 'offline', 'пять часов без связи — не отдых')
  if (offline.kind === 'offline') {
    assert.ok(offline.sinceMs >= 5 * 3_600_000 - 2000, 'нет связи считается от last_seen')
  }

  setSeen(30 * 60_000)
  assert.deepEqual(state(), { kind: 'rest' }, 'полчаса без связи — ещё живой')

  // свежая сессия — тоже связь, даже если last_seen старый
  setSeen(5 * 60 * 60_000)
  const session: LiveSession = {
    id: 'ses_1',
    agent: 'w1',
    title: 'т',
    busy: false,
    updatedAt: Date.now() - 60_000,
    lastAssistantAt: null,
    tool: null,
  }
  assert.deepEqual(state([session]), { kind: 'rest' }, 'свежая сессия снимает офлайн')

  // без last_seen данных нет — не выдумываем ни офлайн, ни работу
  db.prepare('update executors set last_seen = null where id = ?').run('w1')
  assert.deepEqual(state(), { kind: 'rest' }, 'нет отметки связи — отдых, а не догадка')
})

test('занятая свежая сессия исполнителя — работа, даже без задачи', () => {
  const db = openDb(':memory:')
  seed(db)
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })

  const session = (busy: boolean, agoMs: number) => ({
    id: 'ses_1',
    agent: 'w2',
    title: 'F86 исполнители',
    busy,
    updatedAt: Date.now() - agoMs,
  })
  const state = (item: ReturnType<typeof session>) =>
    nowView(db, { sessions: [item] }).holders.find((holder) => holder.executor === 'w2')!.state

  assert.deepEqual(state(session(true, 60_000)), { kind: 'work', taskId: null, title: null })
  assert.deepEqual(state(session(false, 60_000)), { kind: 'rest' }, 'простаивающая сессия — не работа')
  assert.deepEqual(state(session(true, 20 * 60_000)), { kind: 'rest' }, 'старая сессия — не работа')
})

test('состояние по последнему инструменту: работа, тест, фон, молчание', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
    title: 'Шаг',
  })
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = ?").run(task.id)

  const now = Date.now()
  const base = { id: 'ses_1', agent: 'w1', title: 'т', updatedAt: now, lastAssistantAt: now - 5 * 60_000 }
  const tool = (over: Partial<LiveTool>): LiveTool => ({
    name: 'shell',
    command: null,
    status: 'running',
    at: now,
    background: false,
    ...over,
  })
  const stateWith = (session: LiveSession | null) =>
    nowView(db, { sessions: session ? [session] : [] }).holders.find((holder) => holder.executor === 'w1')!
      .state

  assert.deepEqual(
    stateWith({ ...base, busy: true, tool: null }),
    { kind: 'work', taskId: task.id, title: 'Шаг' },
    'сессия занята — работает',
  )
  assert.deepEqual(
    stateWith({ ...base, busy: false, tool: tool({ command: 'node --test tests/core/views.test.ts' }) }),
    { kind: 'test', taskId: task.id },
    'простой и идущие тесты — ждём результата',
  )
  assert.deepEqual(
    stateWith({ ...base, busy: false, tool: tool({ command: 'npm run dev', background: true }) }),
    { kind: 'command', taskId: task.id },
    'простой и команда идёт в фоне',
  )

  // завершённый инструмент — прошедшее время: доска не выдаёт его за ожидание
  const completed = stateWith({
    ...base,
    busy: false,
    tool: tool({ command: 'node --test tests/core/views.test.ts', status: 'completed' }),
  })
  assert.equal(completed.kind, 'silent', 'завершённый тест — молчание')

  const completedBackground = stateWith({
    ...base,
    busy: false,
    tool: tool({ command: 'npm run dev', background: true, status: 'completed' }),
  })
  assert.equal(completedBackground.kind, 'silent', 'завершённая фоновая команда — молчание')

  // сессия сорок минут назад: инструмент «running» в базе уже не ожидание
  const stale = stateWith({
    ...base,
    busy: false,
    updatedAt: now - 40 * 60_000,
    lastAssistantAt: now - 40 * 60_000,
    tool: tool({ command: 'node --test tests/core/views.test.ts' }),
  })
  assert.equal(stale.kind, 'silent', 'старая сессия — молчание, даже если инструмент running')
  if (stale.kind === 'silent') assert.ok(stale.silentMs >= 39 * 60_000, 'молчание считается от последнего сообщения')

  const silent = stateWith({ ...base, busy: false, tool: tool({ name: 'write' }) })
  assert.equal(silent.kind, 'silent', 'простой без тестов и фона — молчание')
  if (silent.kind === 'silent') {
    assert.equal(silent.taskId, task.id)
    assert.ok(silent.silentMs >= 299_000, 'молчание считается от последнего сообщения ассистента')
  }

  // откат без данных остаётся: инструмента нет — молчание, а не выдуманное ожидание
  const noData = stateWith({ ...base, busy: false, tool: null })
  assert.equal(noData.kind, 'silent', 'нет данных об инструменте — молчание')

  assert.deepEqual(
    stateWith(null),
    { kind: 'work', taskId: task.id, title: 'Шаг' },
    'без сессии верим задаче, а не выдумываем простой',
  )
})

test('сданная на ревью задача видна у исполнителя', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
    title: 'Шаг',
  })
  db.prepare("update tasks set status = 'active', holder = 'w1', review = 'agent' where id = ?").run(task.id)
  doneTask(db, { taskId: task.id, executor: 'w1', report: { summary: 'готово', checks: [] } })

  const state = nowView(db).holders.find((holder) => holder.executor === 'w1')!.state
  assert.deepEqual(state, { kind: 'review', taskId: task.id }, 'кто сдал — тот и на ревью')
})

test('задача на ревью — работа этапа, но не задача очереди', () => {
  const db = openDb(':memory:')
  seed(db)
  const first = db.prepare('select id from tasks order by id limit 1').get() as { id: string }

  // как у активной: та же строка этапа и тот же счёт
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = ?").run(first.id)
  const active = ownerView(db).stages[0]!

  db.prepare("update tasks set status = 'in_review', holder = null where id = ?").run(first.id)
  const review = ownerView(db).stages[0]!

  assert.equal(review.status, 'wip', 'на ревью — это работа, а не pending')
  assert.equal(review.status, active.status)
  assert.deepEqual(review.progress, active.progress, 'счёт этапа как у активной')

  // взять её нельзя, а у исполнителя она уже показана: в очереди ей не место
  assert.equal(taskQueue(db).find((item) => item.taskId === first.id), undefined, 'ревью не в очереди')
})

test('снятая занятость исчезает из now', () => {
  const db = openDb(':memory:')
  seed(db)
  setBusy(db, { executorId: 'w1', reason: 'проверка чужой работы', until: '1h', actor: 'w1' })
  assert.notEqual(nowView(db).holders[0].busy, null)

  clearBusy(db, { executorId: 'w1', actor: 'owner' })
  assert.equal(nowView(db).holders[0].busy, null)
})

const reasonOf = (db: DatabaseSync, taskId: string): string | null | undefined =>
  taskQueue(db).find((row) => row.taskId === taskId)?.reason

test('у свободной готовой задачи причина — ждёт раздачи', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  assert.equal(reasonOf(db, `${stageId}-1`), queueFreeReason)
})

test('у назначенной задачи причины нет: держатель и рука', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  db.prepare("update tasks set status = 'active', holder = 'w1' where id = ?").run(`${stageId}-1`)
  setHand(db, 'w1', [`${stageId}-2`], 'owner')

  assert.equal(reasonOf(db, `${stageId}-1`), null, 'держатель — назначена')
  assert.equal(reasonOf(db, `${stageId}-2`), null, 'в руке — назначена')
})

test('причина свободной задачи: нет исполнителя с навыком', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  createTask(db, {
    stageId,
    title: 'Записать выстрелы',
    dod: ['a'],
    size: 'S',
    skill: 'audio',
    class: 'standard',
    scope: ['assets/**'],
  })
  refreshReady(db)

  assert.equal(reasonOf(db, `${stageId}-4`), 'нет исполнителя: audio')
})

test('причина свободной задачи: этап держит другая рука', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = ?").run(`${stageId}-1`)

  // точнее, чем «заняты»: задача того же этапа уйдёт только владельцу этапа
  assert.equal(reasonOf(db, `${stageId}-2`), 'этап у w1')
})

test('владелец этапа без навыка задачи — тупик «нет исполнителя», а не «этап у X»', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = ?").run(`${stageId}-1`)
  createTask(db, {
    stageId,
    title: 'Записать выстрелы',
    dod: ['a'],
    size: 'S',
    skill: 'audio',
    class: 'standard',
    scope: ['assets/**'],
  })
  refreshReady(db)

  // w1 держит этап, но у него только backend: настоящая помеха — навык
  assert.equal(reasonOf(db, `${stageId}-4`), 'нет исполнителя: audio')
})

test('владелец этапа свободен и с навыком — задача просто ждёт раздачи', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  // этап закреплён за w1, но руки свободны: он ещё не взял активную задачу
  setHand(db, 'w1', [`${stageId}-2`], 'owner')

  assert.equal(reasonOf(db, `${stageId}-3`), queueFreeReason)
})

test('причина свободной задачи: ждёт зависимость', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  refreshReady(db)

  assert.equal(reasonOf(db, `${stageId}-2`), `ждёт ${stageId}-1`)
})

test('цепочка зависимостей идёт по порядку: 1, 2, 3', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  // глубина считается по зависимостям, а не по последователям: цепочка не переворачивается
  addDep(db, `${stageId}-2`, `${stageId}-1`)
  addDep(db, `${stageId}-3`, `${stageId}-2`)
  refreshReady(db)

  assert.deepEqual(
    taskQueue(db).map((row) => row.taskId),
    [`${stageId}-1`, `${stageId}-2`, `${stageId}-3`],
  )
})

test('зависимость между фичами: блокер выше, хоть у зависимой лучше ранг', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  // вторая фича ниже по рангу: по прежнему порядку её задачи шли бы после
  const request = addRequest(db, { title: 'Вторая', body: '...', author: 'owner' })
  const second = addFeature(db, { requestId: request.id, name: 'B', rank: 2 })
  const secondStage = addStage(db, { featureId: second.id, name: 'S1', goal: 'g', appetite: 'день' })
  activateNextStage(db, second.id)
  const blocker = createTask(db, {
    stageId: secondStage.id,
    title: 'Блокер другой фичи',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })

  // зависимая — задача первой фичи с лучшим рангом; блокер обязан быть выше
  addDep(db, `${stageId}-1`, blocker.id)
  refreshReady(db)

  const order = taskQueue(db).map((row) => row.taskId)
  assert.ok(
    order.indexOf(blocker.id) < order.indexOf(`${stageId}-1`),
    `блокер ${blocker.id} должен идти выше зависимой ${stageId}-1: ${order.join(', ')}`,
  )
})

test('причина свободной задачи: этап не активен', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update stages set status = 'accepted' where id = ?").run(stageId)

  assert.equal(reasonOf(db, `${stageId}-1`), 'этап не активен')
})

test('причина свободной задачи: у фичи нет каталога', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update features set worktree = null where id = 'F1'").run()

  assert.equal(reasonOf(db, `${stageId}-1`), 'нет каталога фичи')
})

test('причина свободной задачи: статус не ready', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update tasks set status = 'blocked' where id = ?").run(`${stageId}-1`)

  assert.equal(reasonOf(db, `${stageId}-1`), 'не готова: blocked')
})

test('счётчики раздачи различают источник и период прогона', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })
  const [, second, third] = [1, 2, 3].map((n) => `${stageId}-${n}`)

  // выдача рукой до прогона: в срез прогона не попадает
  setHand(db, 'w1', [third], 'owner')
  db.prepare("update events set at = '2000-01-01T00:00:00.000Z' where type = 'hand.assigned'").run()

  const run = startRun(db, { mode: 'plan' })

  // в прогоне: взятие по id без выдачи и добор раздачей
  takeTask(db, { executor: 'w2', taskId: second })
  dispatchPlan(db)

  const stats = assignmentStats(db)
  assert.deepEqual(stats.total, { dispatch: 1, hand: 1, take: 1 }, 'смешанная выдача: по одной на источник')
  assert.deepEqual(stats.run, { dispatch: 1, hand: 0, take: 1 }, 'за прогон — только выдачи прогона')
  assert.deepEqual(nowView(db).assignment, stats, 'now видит те же числа')

  // отчёт пишется только по закрытому прогону — закрываем перед проверкой
  endRun(db, { id: run.id, reason: 'tasks', actor: 'owner' })
  const data = collectRunReport(db, run.id)
  assert.deepEqual(data.assignment, stats.run, 'отчёт прогона считает тот же срез')
  assert.match(
    renderRunReport(data),
    /- раздача: dispatch 1 · руками 0 · без выдачи 1/,
    'в шапке отчёта те же числа',
  )
})

interface LiveRow {
  id: string
  parentId?: string | null
  agent?: string | null
  title?: string | null
  directory?: string | null
  updatedAt?: number
  busyAt?: number | null
  idleAt?: number | null
  archivedAt?: number | null
}

interface LiveMessage {
  sessionId: string
  seq: number
  at: number
  data: string
}

/** Временная база OpenCode: только колонки, которые читает доска. */
function liveDb(
  rows: LiveRow[],
  options: { messages?: LiveMessage[]; withMessages?: boolean } = {},
): string {
  const dir = mkdtempSync(join(tmpdir(), 'al-live-'))
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(`
      create table session_v2 (
        id text primary key,
        parent_id text,
        agent text,
        title text,
        directory text,
        time_updated integer,
        time_busy integer,
        time_idle integer,
        time_archived integer
      )
    `)
    if (options.withMessages !== false) {
      db.exec(`
        create table session_message (
          id text primary key,
          session_id text not null,
          type text not null,
          seq integer not null,
          time_created integer not null,
          time_updated integer not null,
          data text not null
        )
      `)
      const insertMessage = db.prepare(
        `insert into session_message (id, session_id, type, seq, time_created, time_updated, data)
         values (?, ?, 'assistant', ?, ?, ?, ?)`,
      )
      for (const message of options.messages ?? []) {
        insertMessage.run(
          `${message.sessionId}-${message.seq}`,
          message.sessionId,
          message.seq,
          message.at,
          message.at,
          message.data,
        )
      }
    }
    const insert = db.prepare(
      `insert into session_v2 (id, parent_id, agent, title, directory, time_updated, time_busy, time_idle, time_archived)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const row of rows) {
      insert.run(
        row.id,
        row.parentId ?? null,
        row.agent ?? null,
        row.title ?? null,
        row.directory ?? null,
        row.updatedAt ?? 0,
        row.busyAt ?? null,
        row.idleAt ?? null,
        row.archivedAt ?? null,
      )
    }
  } finally {
    db.close()
  }
  return path
}

test('worker-0 работает, пока идёт прогон, даже без задач', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'worker-0', kind: 'agent', skills: [] })
  const worker = () => nowView(db).holders.find((holder) => holder.executor === 'worker-0')!

  assert.equal(worker().working, false, 'без прогона и задач работы нет')
  startRun(db, { mode: 'plan' })
  assert.equal(worker().working, true, 'прогон идёт — оркестратор занят')
})

test('живые субагенты: только дочерние и свежие', () => {
  const now = 10_000_000
  const dbPath = liveDb([
    { id: 'root', agent: 'build', title: 'Главная сессия', updatedAt: now },
    {
      id: 'busy',
      parentId: 'root',
      agent: 'worker-1',
      title: 'worker-1: шаг',
      updatedAt: now - 1000,
      busyAt: now - 500,
      idleAt: now - 9000,
    },
    {
      id: 'idle',
      parentId: 'root',
      agent: 'general',
      title: 'Ревью',
      updatedAt: now - 2000,
      busyAt: now - 9000,
      idleAt: now - 1000,
    },
    { id: 'old', parentId: 'root', agent: 'worker-2', title: 'Старая', updatedAt: now - 3 * 60 * 60 * 1000 },
    {
      id: 'archived',
      parentId: 'root',
      agent: 'worker-2',
      title: 'Архив',
      updatedAt: now - 1000,
      archivedAt: now - 500,
    },
  ])

  const sessions = readLiveSessions({ dbPath, now })
  assert.deepEqual(sessions.map((session) => session.id), ['busy', 'idle'])
  assert.equal(sessions[0]!.busy, true, 'занят: отметка «занят» новее')
  assert.equal(sessions[1]!.busy, false, 'простаивает: отметка «простаивает» новее')
})

test('последний инструмент читается из session_message', () => {
  const now = Date.now()
  const dbPath = liveDb(
    [
      { id: 'ses_1', parentId: 'root', agent: 'worker-1', updatedAt: now, busyAt: now - 1000, idleAt: now - 2000 },
    ],
    {
      messages: [
        {
          sessionId: 'ses_1',
          seq: 1,
          at: now - 5000,
          data: JSON.stringify({ content: [{ type: 'text', text: 'старое' }] }),
        },
        {
          sessionId: 'ses_1',
          seq: 2,
          at: now - 1000,
          data: JSON.stringify({
            content: [
              { type: 'text', text: 'гоняю тесты' },
              {
                type: 'tool',
                name: 'shell',
                state: { status: 'completed', input: { command: 'node --test tests/core/views.test.ts' } },
                time: { created: now - 1200 },
              },
            ],
          }),
        },
      ],
    },
  )

  const [session] = readLiveSessions({ dbPath, now })
  assert.equal(session!.lastAssistantAt, now - 1000, 'берём последнее сообщение ассистента')
  assert.deepEqual(session!.tool, {
    name: 'shell',
    command: 'node --test tests/core/views.test.ts',
    status: 'completed',
    at: now - 1200,
    background: false,
  })
})

test('статус инструмента берётся из metadata, если в state его нет', () => {
  const now = Date.now()
  const dbPath = liveDb([{ id: 'ses_meta', parentId: 'root', agent: 'worker-1', updatedAt: now }], {
    messages: [
      {
        sessionId: 'ses_meta',
        seq: 1,
        at: now,
        data: JSON.stringify({
          content: [
            {
              type: 'tool',
              name: 'shell',
              state: {
                input: { command: 'node --test tests/core/views.test.ts' },
                metadata: { status: 'running' },
              },
              time: { created: now },
            },
          ],
        }),
      },
    ],
  })

  const [session] = readLiveSessions({ dbPath, now })
  assert.equal(session!.tool!.status, 'running', 'metadata.status — запасной источник статуса')
})

test('фон виден по выводу, а битый JSON и отсутствие таблицы — откат без падения', () => {  const now = Date.now()
  const background = JSON.stringify({
    content: [
      {
        type: 'tool',
        name: 'shell',
        state: {
          status: 'running',
          input: { command: 'npm run dev' },
          content: [{ type: 'text', text: 'Command moved to the background (shell ID: sh_1)' }],
        },
        time: { created: now },
      },
    ],
  })

  const dbPath = liveDb(
    [
      { id: 'ses_bg', parentId: 'root', agent: 'worker-1', updatedAt: now },
      { id: 'ses_bad', parentId: 'root', agent: 'worker-2', updatedAt: now },
    ],
    {
      messages: [
        { sessionId: 'ses_bg', seq: 1, at: now, data: background },
        { sessionId: 'ses_bad', seq: 1, at: now, data: '{"content": [битый json' },
      ],
    },
  )

  const sessions = readLiveSessions({ dbPath, now })
  const bg = sessions.find((session) => session.id === 'ses_bg')!
  const bad = sessions.find((session) => session.id === 'ses_bad')!

  assert.equal(bg.tool!.background, true, 'в выводе есть background')
  assert.equal(bad.tool, null, 'битый JSON: инструмента нет, сессия жива')
  assert.equal(bad.lastAssistantAt, now, 'время сообщения при этом известно')

  // таблицы session_message нет вовсе: доска печатается, инструментов просто нет
  const withoutMessages = liveDb([{ id: 'ses_1', parentId: 'root', agent: 'worker-1', updatedAt: now }], {
    withMessages: false,
  })
  const [session] = readLiveSessions({ dbPath: withoutMessages, now })
  assert.equal(session!.tool, null)
  assert.equal(session!.lastAssistantAt, null)
})

test('нет базы OpenCode: живых субагентов просто нет', () => {
  const dbPath = join(tmpdir(), `al-live-missing-${process.pid}-${Date.now()}`, 'opencode.db')

  assert.deepEqual(readLiveSessions({ dbPath, now: Date.now() }), [])
})

