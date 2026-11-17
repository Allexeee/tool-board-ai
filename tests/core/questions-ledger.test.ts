import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { ask, getQuestion, getQuestions } from '../../src/core/questions.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { createTask, updateTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { unblockTask } from '../../src/core/block.ts'
import { closeQuestionsFor } from '../../src/core/questions.ts'

function taskWithBlock(db: DatabaseSync): string {
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '1 день' })
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
  return task.id
}

function askAboutTask(db: DatabaseSync, taskId: string, text = 'Как быть?') {
  return ask(db, { addressee: 'owner', subjectType: 'task', subjectId: taskId, text })
}

test('unblock закрывает вопросы своей задачи', () => {
  const db = openDb(':memory:')
  const taskId = taskWithBlock(db)
  updateTask(db, taskId, { status: 'blocked', reason: 'needs_decision' })
  const question = askAboutTask(db, taskId)
  const foreign = askAboutTask(db, taskWithBlock(db), 'Другой вопрос')

  unblockTask(db, { taskId, actor: 'owner' })

  assert.equal(getQuestion(db, question.id)!.status, 'cancelled')
  assert.equal(getQuestion(db, foreign.id)!.status, 'pending', 'чужой вопрос не тронут')
})

test('done задачи снимает её вопросы', () => {
  const db = openDb(':memory:')
  const taskId = taskWithBlock(db)
  const question = askAboutTask(db, taskId)

  closeQuestionsFor(db, { subjectType: 'task', subjectId: taskId, actor: 'w1', note: 'задача закрыта' })

  assert.equal(getQuestion(db, question.id)!.status, 'cancelled')
  assert.deepEqual(getQuestions(db, { status: 'pending' }), [])
})

test('unblock без вопросов не падает', () => {
  const db = openDb(':memory:')
  const taskId = taskWithBlock(db)
  updateTask(db, taskId, { status: 'blocked', reason: 'needs_decision' })

  assert.doesNotThrow(() => unblockTask(db, { taskId, actor: 'owner' }))
})
