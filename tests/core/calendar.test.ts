import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRoutine, addStep } from '../../src/core/routines.ts'
import { materialize } from '../../src/core/runs.ts'
import { cal } from '../../src/core/calendar.ts'
import { frictionReport } from '../../src/core/friction.ts'
import { doctorReport } from '../../src/core/doctor.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { refreshReady } from '../../src/core/deps.ts'

test('cal показывает прогоны', () => {
  const db = openDb(':memory:')
  const routine = addRoutine(db, { name: 'Деплой', schedule: 'daily 09:00' })
  addStep(db, { routineId: routine.id, title: 'Сборка', kind: 'mechanical', command: 'echo ok' })
  materialize(db, { now: new Date('2026-11-16T00:00:00') })

  const items = cal(db, { days: 7, now: new Date('2026-11-16T00:00:00') })
  assert.ok(items.some((item) => item.kind === 'routine'))
})

test('friction считает долю срочного', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  createTask(db, {
    stageId: stage.id,
    title: 'Срочное',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'expedite',
    scope: ['src/**'],
  })
  createTask(db, {
    stageId: stage.id,
    title: 'Обычное',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)

  const report = frictionReport(db, { days: 7 })
  assert.ok(report.some((item) => item.name === 'доля срочного' && item.value === 50))
})

test('doctor предупреждает про выключенный тикер при наличии рутин', () => {
  const db = openDb(':memory:')
  addRoutine(db, { name: 'Деплой', schedule: 'daily 09:00' })

  const report = doctorReport(db, { schedulerEnabled: false })
  assert.ok(report.checks.some((check) => check.name === 'тикер' && !check.ok))
})
