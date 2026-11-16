import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, getTask, updateTask } from '../../src/core/tasks.ts'
import { addDep, isReady, refreshReady, wouldCycle } from '../../src/core/deps.ts'

function seed(db: DatabaseSync): string {
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

test('зависимость на несуществующий объект отвергается', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  assert.throws(() => addDep(db, `${stageId}-1`, 'NOPE'), /не найден/)
})

test('этап ждёт этап: задача не готова, пока предшествующий этап не слит', () => {
  const db = openDb(':memory:')
  const first = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const second = addRequest(db, { title: 'B', body: '', author: 'owner' })
  const fa = addFeature(db, { requestId: first.id, name: 'A', rank: 1 })
  const fb = addFeature(db, { requestId: second.id, name: 'B', rank: 2 })
  const sa = addStage(db, { featureId: fa.id, name: 'S1', goal: 'g', appetite: '1 день' })
  const sb = addStage(db, { featureId: fb.id, name: 'S1', goal: 'g', appetite: '1 день' })

  addDep(db, sb.id, sa.id)
  activateNextStage(db, fb.id)

  const task = createTask(db, {
    stageId: sb.id,
    title: 'Сделать B',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  assert.equal(isReady(db, task.id), false)

  db.prepare("update stages set status = 'merged' where id = ?").run(sa.id)
  assert.equal(isReady(db, task.id), true)
})

function plannedStage(db: DatabaseSync): { featureId: string; stageId: string; taskId: string } {
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  const task = createTask(db, {
    stageId: stage.id,
    title: 'Первый шаг',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  return { featureId: feature.id, stageId: stage.id, taskId: task.id }
}

test('задача неактивного этапа получает статус planned, а не ready', () => {
  const db = openDb(':memory:')
  const { taskId } = plannedStage(db)

  assert.equal(refreshReady(db), 1)
  assert.equal(getTask(db, taskId)!.status, 'planned')
  assert.equal(isReady(db, taskId), false)
})

test('после активации этапа planned-задача становится ready', () => {
  const db = openDb(':memory:')
  const { featureId, taskId } = plannedStage(db)
  refreshReady(db)
  assert.equal(getTask(db, taskId)!.status, 'planned')

  activateNextStage(db, featureId)
  assert.equal(refreshReady(db), 1)
  assert.equal(getTask(db, taskId)!.status, 'ready')
})

test('в активном этапе незакрытая зависимость оставляет задачу open', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  addDep(db, `${stageId}-1`, `${stageId}-2`)

  refreshReady(db)
  assert.equal(getTask(db, `${stageId}-1`)!.status, 'open')
  assert.equal(getTask(db, `${stageId}-2`)!.status, 'ready')
})
