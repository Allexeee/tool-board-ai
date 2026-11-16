import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRoutine, addStep } from '../../src/core/routines.ts'
import { tick } from '../../src/core/tick.ts'
import { makeRepo } from '../helpers/repo.ts'

test('вне окна прогон откладывается, в окне исполняется', () => {
  const db = openDb(':memory:')
  const root = makeRepo()
  const routine = addRoutine(db, { name: 'Деплой', schedule: 'daily 02:00', window: '02:00-04:00' })
  addStep(db, { routineId: routine.id, title: 'Сборка', kind: 'mechanical', command: 'echo ok' })

  const outside = tick(db, { root, now: new Date('2026-11-16T10:00:00') })
  assert.equal(outside.executed.length, 0)
  assert.ok(outside.deferred.length > 0)

  const inside = tick(db, { root, now: new Date('2026-11-17T03:00:00') })
  assert.ok(inside.executed.length > 0)
})
