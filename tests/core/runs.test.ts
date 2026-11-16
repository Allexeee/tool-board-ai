import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRoutine } from '../../src/core/routines.ts'
import { listRuns, materialize } from '../../src/core/runs.ts'

function fixture(db: DatabaseSync) {
  return addRoutine(db, { name: 'Деплой', schedule: 'daily 09:00' })
}

test('прогон материализуется заранее и не дублируется', () => {
  const db = openDb(':memory:')
  fixture(db)

  const now = new Date('2026-11-16T00:00:00')
  const runs = materialize(db, { now })
  assert.equal(runs.length, 1)
  assert.equal(materialize(db, { now }).length, 0)
  assert.equal(listRuns(db).length, 1)
})

test('прогон не создаётся раньше окна материализации', () => {
  const db = openDb(':memory:')
  const routine = addRoutine(db, { name: 'Деплой', schedule: 'every 30d 09:00' })
  assert.equal(materialize(db, { now: new Date('2026-11-16T00:00:00') }).length, 0)
  assert.equal(listRuns(db).length, 0)
  assert.ok(routine.id)
})
