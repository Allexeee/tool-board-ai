import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, getTask, attempt, updateTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
import { fillHand, getHand } from '../../src/core/hands.ts'
import { blockTask, unblockTask } from '../../src/core/block.ts'
import { doneTask, reopenTask } from '../../src/core/done.ts'
import { answer, getQuestions } from '../../src/core/questions.ts'

function seed(db: DatabaseSync): string {
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
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
  createTask(db, { ...base, title: 'Третий шаг' })
  refreshReady(db)
  return stage.id
}

test('block снимает задачу из руки и возвращает в пул', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  fillHand(db, 'w1')
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })

  const task = blockTask(db, {
    taskId: `${stageId}-1`,
    executor: 'w1',
    reason: 'needs_data',
    note: 'нет ключей',
  })

  assert.equal(task.status, 'blocked')
  assert.equal(getHand(db, 'w1').some((item) => item.id === task.id), false)
})

test('needs_decision уходит владельцу', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })

  const task = blockTask(db, {
    taskId: `${stageId}-1`,
    executor: 'w1',
    reason: 'needs_decision',
    note: 'какой макет?',
  })

  assert.equal(task.status, 'needs_owner')
  assert.ok(getQuestions(db, { addressee: 'owner' }).some((q) => q.subjectId === task.id))
})

test('третья неудача переводит в needs_owner', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  attempt(db, `${stageId}-1`)
  attempt(db, `${stageId}-1`)
  attempt(db, `${stageId}-1`)

  assert.equal(getTask(db, `${stageId}-1`)!.status, 'needs_owner')
})

test('done без отчёта отвергается', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })

  assert.throws(
    () => doneTask(db, { taskId: `${stageId}-1`, executor: 'w1', report: { summary: '', checks: [] } }),
    /отчёт/,
  )
})

test('done закрывает задачу и пишет отчёт в журнал', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })

  const task = doneTask(db, {
    taskId: `${stageId}-1`,
    executor: 'w1',
    report: { summary: 'вебхук принимает событие', checks: ['npm test'] },
  })

  assert.equal(task.status, 'done')
})

test('нельзя переоткрыть задачу слитого этапа', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const task = getTask(db, `${stageId}-1`)!
  updateTask(db, task.id, { status: 'done' })
  db.prepare("update stages set status = 'merged' where id = ?").run(stageId)

  assert.throws(() => reopenTask(db, { taskId: task.id, actor: 'owner', reason: 'вернуть' }), /слит/)
  assert.equal(getTask(db, task.id)!.status, 'done')
})

test('unblock возвращает задачу в ready и сбрасывает попытки', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })
  blockTask(db, {
    taskId: `${stageId}-1`,
    executor: 'w1',
    reason: 'needs_data',
    note: 'нет ключей',
  })
  updateTask(db, `${stageId}-1`, { attempts: 2 })

  const task = unblockTask(db, { taskId: `${stageId}-1`, actor: 'owner', note: 'ключи выданы' })

  assert.equal(task.status, 'ready')
  assert.equal(task.attempts, 0)
  assert.equal(task.reason, null)
})

test('ответ на вопрос разблокирует задачу', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  takeTask(db, { executor: 'w1', taskId: `${stageId}-1` })
  const blocked = blockTask(db, {
    taskId: `${stageId}-1`,
    executor: 'w1',
    reason: 'needs_decision',
    note: 'какой макет?',
  })
  const question = getQuestions(db, { addressee: 'owner' }).find((q) => q.subjectId === blocked.id)!

  answer(db, { id: question.id, answer: 'первый', actor: 'owner' })

  const task = getTask(db, blocked.id)!
  assert.equal(task.status, 'ready')
  assert.equal(task.reason, null)
})

