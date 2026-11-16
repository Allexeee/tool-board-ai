import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { takeTask } from '../../src/core/lease.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { nextTask } from '../../src/core/hands.ts'
import { preempt } from '../../src/core/preempt.ts'
import { listEvents } from '../../src/core/events.ts'

function seed(db: DatabaseSync): string {
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g' })
  activateNextStage(db, feature.id)
  return stage.id
}

const base = (stageId: string) => ({
  stageId,
  dod: ['a'],
  size: 'S' as const,
  skill: 'backend',
  scope: ['src/**'],
})

test('expedite выдаётся первым', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  createTask(db, { ...base(stageId), title: 'Добавить профиль', class: 'standard' })
  const urgent = createTask(db, { ...base(stageId), title: 'Починить оплату', class: 'expedite' })
  refreshReady(db)

  assert.equal(nextTask(db, 'w1')!.id, urgent.id)
})

test('лимит: второй active expedite у того же исполнителя отвергается', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const first = createTask(db, { ...base(stageId), title: 'Починить вход', class: 'expedite' })
  const second = createTask(db, { ...base(stageId), title: 'Починить выход', class: 'expedite' })
  refreshReady(db)

  takeTask(db, { executor: 'w1', taskId: first.id })
  assert.throws(() => takeTask(db, { executor: 'w1', taskId: second.id }), /лимит/)
})

test('preempt пишет в журнал, что вытеснено', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const running = createTask(db, { ...base(stageId), title: 'Добавить профиль', class: 'standard' })
  refreshReady(db)
  takeTask(db, { executor: 'w1', taskId: running.id })

  const urgent = createTask(db, { ...base(stageId), title: 'Упал прод', class: 'expedite' })
  refreshReady(db)
  preempt(db, { taskId: urgent.id, executor: 'w1', actor: 'orchestrator' })

  const event = listEvents(db, { subject: running.id }).at(-1)!
  assert.equal(event.type, 'task.preempted')
  assert.match(event.note ?? '', /вытеснено/)
})
