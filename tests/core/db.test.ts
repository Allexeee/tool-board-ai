import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, migrate } from '../../src/core/db.ts'
import { appendEvent, listEvents } from '../../src/core/events.ts'

test('миграция идемпотентна и создаёт таблицы', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), 2)
  assert.equal(migrate(db), 2)
  const names = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map(r => r.name)
  for (const t of ['meta', 'events', 'executors', 'requests', 'features', 'stages', 'tasks', 'deps', 'hand', 'questions'])
    assert.ok(names.includes(t), t)
})

test('событие пишется и читается в порядке вставки', () => {
  const db = openDb(':memory:')
  appendEvent(db, { type: 'task.created', actor: 'orchestrator', subject: 'F1.S1-1' })
  appendEvent(db, { type: 'task.taken', actor: 'w1', subject: 'F1.S1-1' })
  assert.deepEqual(listEvents(db, { subject: 'F1.S1-1' }).map(e => e.type), ['task.created', 'task.taken'])
})
