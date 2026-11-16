import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { ask, answer, getQuestions, inbox, ownerHand, type Question } from '../../src/core/questions.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { createTask, updateTask, getTask } from '../../src/core/tasks.ts'
import { advanceTime } from '../../src/core/clock.ts'

function seed(db: DatabaseSync): string {
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  return addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' }).id
}

test('вопрос владельцу попадает в inbox и закрывается ответом', () => {
  const db = openDb(':memory:')
  seed(db)
  const question = ask(db, {
    addressee: 'owner',
    text: 'ЮKassa или Stripe?',
    options: ['ЮKassa', 'Stripe'],
    subjectType: 'request',
    subjectId: 'R1',
  })

  assert.ok(inbox(db).some((item) => item.id === question.id))
  answer(db, { id: question.id, answer: 'ЮKassa', actor: 'owner' })
  assert.equal(inbox(db).some((item) => item.id === question.id), false)
})

test('рука владельца сортирует по сроку', () => {
  const db = openDb(':memory:')
  seed(db)
  ask(db, { addressee: 'owner', text: 'позже', subjectType: 'request', subjectId: 'R1', deadline: '2030-01-01T00:00:00.000Z' })
  ask(db, { addressee: 'owner', text: 'срочно', subjectType: 'request', subjectId: 'R1', deadline: '2020-01-01T00:00:00.000Z' })

  const questions = ownerHand(db).filter((item) => item.kind === 'question')
  assert.equal((questions[0].item as Question).text, 'срочно')
})

test('задача, закреплённая за владельцем, в его руке', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const task = createTask(db, {
    stageId,
    title: 'Создать сообщество',
    dod: ['сообщество есть'],
    size: 'S',
    skill: 'ops',
    class: 'standard',
    scope: ['docs/**'],
  })
  updateTask(db, task.id, { status: 'active', holder: 'owner' })

  assert.ok(ownerHand(db).some((item) => item.kind === 'task' && (item.item as Task).holder === 'owner'))
})

test('вопрос с истёкшим сроком и политикой proceed закрывается сам', () => {
  const db = openDb(':memory:')
  seed(db)
  const question = ask(db, {
    addressee: 'owner',
    text: 'макет?',
    subjectType: 'request',
    subjectId: 'R1',
    deadline: '2020-01-01T00:00:00.000Z',
    timeoutPolicy: 'proceed',
  })

  advanceTime(db)
  const after = getQuestions(db, { status: 'answered' }).find((item) => item.id === question.id)
  assert.ok(after)
  assert.match(after!.answer ?? '', /срок истёк/)
})

test('ответ на чужой вопрос отвергается', () => {
  const db = openDb(':memory:')
  seed(db)
  const question = ask(db, { addressee: 'owner', text: 'x', subjectType: 'request', subjectId: 'R1' })
  assert.throws(() => answer(db, { id: question.id, answer: 'y', actor: 'w1' }), /адресован/)
})

import type { Task } from '../../src/core/tasks.ts'
