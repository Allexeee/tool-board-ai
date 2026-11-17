import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate } from '../../src/core/db.ts'
import { SCHEMA_VERSION } from '../../src/core/schema.ts'
import { UserError } from '../../src/cli/errors.ts'
import { appendEvent, listEvents } from '../../src/core/events.ts'

test('миграция идемпотентна и создаёт таблицы', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), SCHEMA_VERSION)
  assert.equal(migrate(db), SCHEMA_VERSION)
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

test('схема новее инструмента: отказ с подсказкой обновить', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-newer-'))
  const path = join(dir, 'tracker.db')
  const seed = openDb(path)
  seed.prepare("update meta set value = ? where key = 'schemaVersion'").run(String(SCHEMA_VERSION + 1))
  seed.close()

  assert.throws(
    () => openDb(path),
    (error: unknown) =>
      error instanceof UserError &&
      error.code === 3 &&
      /новее/.test(error.message) &&
      /обновите/.test(error.message) &&
      /upgrade/.test(error.message),
  )
})

test('с allowOutdated схема новее всё равно не открывается', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-newer-allowed-'))
  const path = join(dir, 'tracker.db')
  const seed = openDb(path)
  seed.prepare("update meta set value = ? where key = 'schemaVersion'").run(String(SCHEMA_VERSION + 1))
  seed.close()

  assert.throws(() => openDb(path, { allowOutdated: true }), /новее/)
})
