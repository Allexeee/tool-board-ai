import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { ask, getQuestion, closeQuestionsFor } from '../../src/core/questions.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, updateTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
import { blockTask, unblockTask } from '../../src/core/block.ts'

function taskInHand(): { db: DatabaseSync; taskId: string } {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '1 день' })
  activateNextStage(db, feature.id)

  const task = createTask(db, {
    stageId: stage.id,
    title: 'Правка',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)
  takeTask(db, { executor: 'w1', taskId: task.id })
  return { db, taskId: task.id }
}

test('unblock гасит вопрос от блокировки и не трогает заданный через ask', () => {
  const { db, taskId } = taskInHand()

  blockTask(db, { taskId, executor: 'w1', reason: 'needs_decision', note: 'нет данных' })
  const own = db
    .prepare("select id from questions where subject_id = ? and status = 'pending'")
    .get(taskId) as { id: string }
  const honest = ask(db, { addressee: 'owner', text: 'Как округление?', subjectType: 'task', subjectId: taskId })

  unblockTask(db, { taskId, actor: 'owner' })

  assert.equal(getQuestion(db, own.id)!.status, 'cancelled')
  assert.equal(getQuestion(db, honest.id)!.status, 'pending', 'честный вопрос остаётся владельцу')
})

test('закрытие вопросов по одной задаче не задевает другую', () => {
  const { db, taskId } = taskInHand()
  const first = ask(db, { addressee: 'owner', text: 'Первый', subjectType: 'task', subjectId: taskId })
  const second = ask(db, { addressee: 'owner', text: 'Второй', subjectType: 'task', subjectId: taskId })

  closeQuestionsFor(db, {
    subjectType: 'task',
    subjectId: taskId,
    actor: 'owner',
    note: 'точечно',
    questionId: first.id,
  })

  assert.equal(getQuestion(db, first.id)!.status, 'cancelled')
  assert.equal(getQuestion(db, second.id)!.status, 'pending')
})
