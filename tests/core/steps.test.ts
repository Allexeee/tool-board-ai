import test from 'node:test'
import assert from 'node:assert/strict'
import { createCard, getCard } from '../../src/core/cards.ts'
import { listEvents } from '../../src/core/events.ts'
import {
  addStep,
  doneStep,
  listSteps,
  removeStep,
  stepProgress,
} from '../../src/core/steps.ts'
import { makeBoard } from '../helpers/board.ts'

function makeCardBoard(t: { after: (fn: () => void) => void }) {
  const board = makeBoard()
  t.after(board.close)
  const card = createCard(board.db, {
    group: 'UI',
    title: 'x',
    skill: 'dev',
    author: 'owner',
  })
  return { db: board.db, card }
}

test('addStep нумерует шаги по порядку', (t) => {
  const { db, card } = makeCardBoard(t)

  const first = addStep(db, { cardId: card.id, text: 'Написать форму' })
  const second = addStep(db, { cardId: card.id, text: '  Добавить тест  ' })

  assert.deepEqual(first, {
    cardId: card.id,
    seq: 1,
    text: 'Написать форму',
    done: false,
    doneAt: null,
  })
  assert.equal(second.seq, 2)
  assert.equal(second.text, 'Добавить тест')
  assert.deepEqual(
    listSteps(db, card.id).map((step) => [step.seq, step.text]),
    [
      [1, 'Написать форму'],
      [2, 'Добавить тест'],
    ],
  )
})

test('addStep продлевает lease карточки в работе', (t) => {
  const { db, card } = makeCardBoard(t)
  const old = new Date(Date.now() - 60_000).toISOString()
  db.prepare(
    "update cards set status = 'in_progress', holder = 'developer', lease_until = ? where id = ?",
  ).run(old, card.id)

  addStep(db, { cardId: card.id, text: 'шаг', actor: 'developer' })

  const after = getCard(db, card.id)!
  assert.ok(after.leaseUntil !== null)
  assert.ok(new Date(after.leaseUntil!).getTime() > Date.now() + 60 * 60 * 1000)
})

test('addStep пишет событие в журнал карточки', (t) => {
  const { db, card } = makeCardBoard(t)

  addStep(db, { cardId: card.id, text: 'Написать форму', actor: 'developer' })

  const events = listEvents(db, card.id)
  assert.equal(events.at(-1)!.type, 'step.added')
  assert.equal(events.at(-1)!.actor, 'developer')
})

test('doneStep отмечает шаг и снимает отметку', (t) => {
  const { db, card } = makeCardBoard(t)
  addStep(db, { cardId: card.id, text: 'Написать форму' })
  addStep(db, { cardId: card.id, text: 'Добавить тест' })

  assert.deepEqual(stepProgress(db, card.id), { done: 0, total: 2 })

  const done = doneStep(db, { cardId: card.id, seq: 1 })
  assert.equal(done.done, true)
  assert.match(done.doneAt ?? '', /^\d{4}-\d{2}-\d{2}T/)
  assert.deepEqual(stepProgress(db, card.id), { done: 1, total: 2 })

  const reopened = doneStep(db, { cardId: card.id, seq: 1, done: false })
  assert.equal(reopened.done, false)
  assert.equal(reopened.doneAt, null)
  assert.deepEqual(stepProgress(db, card.id), { done: 0, total: 2 })
})

test('doneStep не трогает другие шаги', (t) => {
  const { db, card } = makeCardBoard(t)
  addStep(db, { cardId: card.id, text: 'Первый' })
  addStep(db, { cardId: card.id, text: 'Второй' })

  doneStep(db, { cardId: card.id, seq: 2 })

  assert.deepEqual(
    listSteps(db, card.id).map((step) => step.done),
    [false, true],
  )
})

test('removeStep удаляет шаг, следующий номер не переиспользуется', (t) => {
  const { db, card } = makeCardBoard(t)
  addStep(db, { cardId: card.id, text: 'Первый' })
  addStep(db, { cardId: card.id, text: 'Второй' })
  addStep(db, { cardId: card.id, text: 'Третий' })

  const removed = removeStep(db, { cardId: card.id, seq: 2 })
  assert.equal(removed.text, 'Второй')
  assert.deepEqual(
    listSteps(db, card.id).map((step) => step.seq),
    [1, 3],
  )

  const next = addStep(db, { cardId: card.id, text: 'Четвёртый' })
  assert.equal(next.seq, 4)
})

test('stepProgress на карточке без шагов — ноль', (t) => {
  const { db, card } = makeCardBoard(t)
  assert.deepEqual(stepProgress(db, card.id), { done: 0, total: 0 })
  assert.deepEqual(listSteps(db, card.id), [])
})

test('шаги проверяют текст, карточку и номер', (t) => {
  const { db, card } = makeCardBoard(t)

  assert.throws(() => addStep(db, { cardId: card.id, text: '  ' }), /текст/)
  assert.throws(() => addStep(db, { cardId: 'UI-9', text: 'x' }), /не найдена/)
  assert.throws(() => doneStep(db, { cardId: card.id, seq: 1 }), /не найден/)
  assert.throws(() => removeStep(db, { cardId: card.id, seq: 0 }), /номер/)
})
