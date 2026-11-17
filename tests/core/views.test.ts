import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature, setFeatureBranch } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor, clearBusy, setBusy } from '../../src/core/executors.ts'
import { setHand } from '../../src/core/hands.ts'
import { addDep } from '../../src/core/deps.ts'
import { takeTask } from '../../src/core/lease.ts'
import { endRun, startRun } from '../../src/core/runs.ts'
import { collectRunReport, renderRunReport } from '../../src/core/run-report.ts'
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

test('причина свободной задачи: все исполнители с навыком заняты', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = ?").run(`${stageId}-1`)

  assert.equal(reasonOf(db, `${stageId}-2`), 'исполнители заняты')
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

