import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature, setFeatureBranch } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { nowView, dispatchPlan } from '../../src/core/views.ts'

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
