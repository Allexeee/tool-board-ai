import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { nowView, dispatchPlan } from '../../src/core/views.ts'

function seed(db: DatabaseSync): string {
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g' })
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
