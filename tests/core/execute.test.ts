import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRoutine, addStep } from '../../src/core/routines.ts'
import { addGate } from '../../src/core/gates.ts'
import { materialize } from '../../src/core/runs.ts'
import { executeRun } from '../../src/core/execute.ts'
import { makeRepo } from '../helpers/repo.ts'

function runWith(db: DatabaseSync, steps: Parameters<typeof addStep>[1][], gate?: 'approval') {
  const routine = addRoutine(db, { name: 'R', schedule: 'daily 09:00' })
  for (const step of steps) addStep(db, { ...step, routineId: routine.id })
  if (gate === 'approval') {
    const created = addGate(db, { routineId: routine.id, kind: 'approval', name: 'first', once: true })
    return { routine, gateId: created.id }
  }
  return { routine, gateId: null }
}

test('механический шаг выполняется и пишет результат', () => {
  const db = openDb(':memory:')
  const root = makeRepo()
  runWith(db, [{ title: 'Печать', kind: 'mechanical', command: 'echo hello' }])

  const [run] = materialize(db, { now: new Date('2026-11-16T00:00:00') })
  const result = executeRun(db, { runId: run.id, root })

  assert.equal(result.status, 'done')
  assert.match(result.steps[0].result, /hello/)
})

test('падение команды делает прогон частичным', () => {
  const db = openDb(':memory:')
  const root = makeRepo()
  runWith(db, [{ title: 'Падение', kind: 'mechanical', command: 'git rev-parse --verify refs/heads/nope' }])

  const [run] = materialize(db, { now: new Date('2026-11-16T00:00:00') })
  const result = executeRun(db, { runId: run.id, root })

  assert.equal(result.status, 'partial')
  assert.ok(result.steps[0].result.length > 0)
})

test('невыполненный approval-гейт держит шаг', () => {
  const db = openDb(':memory:')
  const root = makeRepo()
  runWith(db, [{ title: 'Публикация', kind: 'mechanical', command: 'echo x' }], 'approval')

  const [run] = materialize(db, { now: new Date('2026-11-16T00:00:00') })
  const result = executeRun(db, { runId: run.id, root })

  assert.equal(result.status, 'waiting_gate')
})

test('агентский шаг создаёт задачу без этапа', () => {
  const db = openDb(':memory:')
  const root = makeRepo()
  runWith(db, [
    {
      title: 'Сделать контент',
      kind: 'agent',
      skill: 'content',
      dod: ['7 постов'],
      scope: ['content/**'],
    },
  ])

  const [run] = materialize(db, { now: new Date('2026-11-16T00:00:00') })
  const result = executeRun(db, { runId: run.id, root })

  assert.equal(result.status, 'done')
  assert.match(result.steps[0].result, /задача/)
})
