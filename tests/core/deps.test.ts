import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { createTask, updateTask } from '../../src/core/tasks.ts'
import { addDep, isReady, refreshReady, wouldCycle } from '../../src/core/deps.ts'

function seed(db: DatabaseSync): string {
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g' })

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
  return stage.id
}

test('прямой цикл отвергается с путём', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-1`, `${stageId}-2`)

  assert.deepEqual(wouldCycle(db, `${stageId}-2`, `${stageId}-1`), [
    `${stageId}-1`,
    `${stageId}-2`,
    `${stageId}-1`,
  ])
  assert.throws(() => addDep(db, `${stageId}-2`, `${stageId}-1`), /цикл/)
})

test('задача готова только когда предшественник закрыт', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-1`, `${stageId}-2`)

  assert.equal(isReady(db, `${stageId}-1`), false)
  updateTask(db, `${stageId}-2`, { status: 'done' })
  assert.equal(isReady(db, `${stageId}-1`), true)
})

test('refreshReady переводит open в ready и обратно', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  assert.equal(refreshReady(db), 2)
  assert.equal(isReady(db, `${stageId}-1`), true)
})
