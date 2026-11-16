import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
import { doneTask } from '../../src/core/done.ts'
import { submitReview } from '../../src/core/reviews.ts'
import { ownerHand } from '../../src/core/questions.ts'

function readyForReview(review: 'none' | 'agent' | 'owner' = 'agent') {
  const db: DatabaseSync = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })

  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  const task = createTask(db, {
    stageId: stage.id,
    title: 'Добавить вебхук',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
    review,
  })
  refreshReady(db)
  takeTask(db, { executor: 'w1', taskId: task.id })
  doneTask(db, { taskId: task.id, executor: 'w1', report: { summary: 'готово', checks: [] } })

  return { db, task: getTask(db, task.id)! }
}

test('задача с ревью ждёт вердикта', () => {
  const { task } = readyForReview('agent')
  assert.equal(task.status, 'in_review')
})

test('агентское ревью закрывает задачу', () => {
  const { db, task } = readyForReview('agent')
  const review = submitReview(db, { taskId: task.id, reviewer: 'w2', verdict: 'approved' })
  assert.equal(review.verdict, 'approved')
  assert.equal(getTask(db, task.id)!.status, 'done')
})

test('свою задачу ревьюить нельзя', () => {
  const { db, task } = readyForReview('agent')
  assert.throws(
    () => submitReview(db, { taskId: task.id, reviewer: 'w1', verdict: 'approved' }),
    /свою/,
  )
})

test('отклонение требует причины и возвращает в работу', () => {
  const { db, task } = readyForReview('agent')
  assert.throws(() => submitReview(db, { taskId: task.id, reviewer: 'w2', verdict: 'rejected' }), /причин/)

  submitReview(db, { taskId: task.id, reviewer: 'w2', verdict: 'rejected', note: 'нет теста' })
  assert.equal(getTask(db, task.id)!.status, 'ready')
})

test('задача с review=owner ждёт владельца в руке', () => {
  const { db, task } = readyForReview('owner')
  assert.ok(ownerHand(db).some((item) => item.id === task.id))
})
