import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRoutine, addStep, listRoutines, listSteps } from '../../src/core/routines.ts'

function fixture(db: DatabaseSync) {
  return addRoutine(db, { name: 'Пинтерест', schedule: 'every 7d 09:00' })
}

test('рутина с агентским и механическим шагом', () => {
  const db = openDb(':memory:')
  const routine = fixture(db)
  const agent = addStep(db, {
    routineId: routine.id,
    title: 'Сделать контент',
    kind: 'agent',
    skill: 'content',
    dod: ['7 постов'],
    scope: ['content/**'],
  })
  const mechanical = addStep(db, {
    routineId: routine.id,
    title: 'Залить',
    kind: 'mechanical',
    command: 'echo ok',
  })

  assert.equal(agent.seq, 1)
  assert.equal(mechanical.seq, 2)
  assert.equal(listSteps(db, routine.id).length, 2)
  assert.equal(listRoutines(db)[0].id, routine.id)
})

test('агентский шаг требует навык и DoD', () => {
  const db = openDb(':memory:')
  const routine = fixture(db)
  assert.throws(() => addStep(db, { routineId: routine.id, title: 'x', kind: 'agent' }), /навык/)
})

test('механический шаг требует команду', () => {
  const db = openDb(':memory:')
  const routine = fixture(db)
  assert.throws(
    () => addStep(db, { routineId: routine.id, title: 'x', kind: 'mechanical' }),
    /команд/,
  )
})
