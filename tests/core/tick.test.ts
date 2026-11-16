import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRoutine, addStep } from '../../src/core/routines.ts'
import { addGate } from '../../src/core/gates.ts'
import { tick } from '../../src/core/tick.ts'
import { listRuns } from '../../src/core/runs.ts'
import { getQuestions } from '../../src/core/questions.ts'
import { makeRepo } from '../helpers/repo.ts'

function fixture(db: DatabaseSync) {
  const routine = addRoutine(db, { name: 'Деплой', schedule: 'daily 09:00' })
  addStep(db, { routineId: routine.id, title: 'Сборка', kind: 'mechanical', command: 'echo ok' })
  return routine
}

test('tick материализует заранее и не исполняет до срока', () => {
  const db = openDb(':memory:')
  const root = makeRepo()
  fixture(db)

  const result = tick(db, { root, now: new Date('2026-11-16T08:00:00') })
  assert.equal(result.materialized, 1)
  assert.equal(result.executed.length, 0)
})

test('после срока прогон исполняется', () => {
  const db = openDb(':memory:')
  const root = makeRepo()
  fixture(db)

  tick(db, { root, now: new Date('2026-11-16T08:00:00') })
  const result = tick(db, { root, now: new Date('2026-11-16T09:30:00') })

  assert.equal(result.executed.length, 1)
  assert.equal(listRuns(db).find((run) => run.dueAt.startsWith('2026-11-16'))!.status, 'done')
})

test('три прогона в блоке дают одну эскалацию', () => {
  const db = openDb(':memory:')
  const root = makeRepo()
  const routine = fixture(db)
  addGate(db, { routineId: routine.id, kind: 'approval', name: 'first', once: true })

  for (const day of ['16', '17', '18', '19']) {
    tick(db, { root, now: new Date(`2026-11-${day}T10:00:00`) })
  }

  const questions = getQuestions(db, { addressee: 'owner' }).filter((q) => q.text.includes('рутина'))
  assert.equal(questions.length, 1)
})
