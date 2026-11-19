import test from 'node:test'
import assert from 'node:assert/strict'
import { appendEvent, listEvents } from '../../src/core/events.ts'
import { makeBoard } from '../helpers/board.ts'

test('событие карточки пишется с автором и json-снимками', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  appendEvent(db, {
    type: 'card.created',
    actor: 'developer',
    subject: 'UI-1',
    after: { title: 'x' },
  })
  appendEvent(db, {
    type: 'card.status',
    actor: 'developer',
    subject: 'UI-1',
    before: { status: 'ready' },
    after: { status: 'in_progress' },
    note: 'взял в работу',
  })

  const events = listEvents(db, 'UI-1')
  assert.equal(events.length, 2)
  assert.equal(events[0].type, 'card.created')
  assert.equal(events[0].actor, 'developer')
  assert.deepEqual(JSON.parse(events[0].after!), { title: 'x' })
  assert.equal(events[0].before, null)

  assert.equal(events[1].type, 'card.status')
  assert.deepEqual(JSON.parse(events[1].before!), { status: 'ready' })
  assert.equal(events[1].note, 'взял в работу')
  assert.match(events[0].at, /^\d{4}-\d{2}-\d{2}T.*Z$/)
})

test('listEvents без субъекта отдаёт весь журнал по порядку', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  appendEvent(db, { type: 'a', actor: 'owner', subject: 'UI-1' })
  appendEvent(db, { type: 'b', actor: 'owner', subject: 'IM-1' })

  assert.deepEqual(
    listEvents(db).map((event) => event.type),
    ['a', 'b'],
  )
  assert.deepEqual(
    listEvents(db, 'IM-1').map((event) => event.type),
    ['b'],
  )
})

test('listEvents умеет границу по времени', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  appendEvent(db, { type: 'old', actor: 'owner', subject: 'UI-1' })

  assert.deepEqual(listEvents(db, { since: '2999-01-01T00:00:00.000Z' }), [])
})
