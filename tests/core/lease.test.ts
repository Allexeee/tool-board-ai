import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { advanceTime } from '../../src/core/clock.ts'
import { takeTask } from '../../src/core/lease.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { addDep } from '../../src/core/deps.ts'

const plusMinutes = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

function seed(db: DatabaseSync): string {
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })

  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
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
  refreshReady(db)
  return stage.id
}

test('истёкшая аренда возвращает задачу и считает попытку', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  assert.equal(takeTask(db, { executor: 'w1', taskId: `${stageId}-1` }).status, 'active')
  advanceTime(db, plusMinutes(31))

  const after = getTask(db, `${stageId}-1`)!
  assert.equal(after.status, 'ready')
  assert.equal(after.attempts, 1)
})

test('двое одновременно: второй получает код 1', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })

  assert.throws(
    () => takeTask(db, { executor: 'w2', taskId: `${stageId}-1` }),
    (error: { code?: number }) => error.code === 1,
  )
})

test('часы назад не воскрешают аренду', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })
  advanceTime(db, plusMinutes(31))
  advanceTime(db, plusMinutes(-60))

  assert.equal(getTask(db, `${stageId}-1`)!.attempts, 1)
})

test('WIP: вторая задача тому же исполнителю не выдаётся', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })

  assert.throws(() => takeTask(db, { executor: 'w1', taskId: `${stageId}-2` }), /WIP/)
})

test('третье истечение аренды уходит владельцу', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare('update tasks set attempts = 2 where id = ?').run(`${stageId}-1`)

  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })
  advanceTime(db, plusMinutes(31))

  assert.equal(getTask(db, `${stageId}-1`)!.status, 'needs_owner')
})

test('нельзя взять задачу без нужного навыка', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addExecutor(db, { id: 'designer', kind: 'agent', skills: ['design'] })

  assert.throws(() => takeTask(db, { executor: 'designer', taskId: `${stageId}-1` }), /навык backend/)
})

test('нельзя взять задачу с незакрытой зависимостью', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-1`, `${stageId}-2`)
  refreshReady(db)

  assert.throws(() => takeTask(db, { executor: 'w1', taskId: `${stageId}-1` }), /не готова/)
})

test('нельзя взять задачу неактивного этапа', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  db.prepare("update stages set status = 'planned'").run()

  assert.throws(() => takeTask(db, { executor: 'w1', taskId: `${stageId}-1` }), /этап/)
})

test('задачу пула можно взять без этапа', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    title: 'Поправить опечатку',
    dod: ['опечатки нет'],
    size: 'XS',
    skill: 'backend',
    class: 'quick',
    scope: ['docs/**'],
  })
  refreshReady(db)

  const taken = takeTask(db, { executor: 'w1', taskId: task.id })
  assert.equal(taken.status, 'active')
})
