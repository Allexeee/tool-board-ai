import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, updateTask, undeferTask } from '../../src/core/tasks.ts'
import { acceptStage } from '../../src/core/accept.ts'
import { refreshReady } from '../../src/core/deps.ts'

function stageWithTwoTasks() {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оп��та', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '1 день' })
  activateNextStage(db, feature.id)

  const base = {
    stageId: stage.id,
    dod: ['a'],
    size: 'S' as const,
    skill: 'backend',
    class: 'standard' as const,
    scope: ['src/**'],
  }
  const first = createTask(db, { ...base, title: 'Сделано' })
  const second = createTask(db, { ...base, title: 'Отложено' })
  refreshReady(db)

  return { db, stage, first, second }
}

test('приёмка этапа не ждёт отложенных задач', () => {
  const { db, stage, first, second } = stageWithTwoTasks()
  updateTask(db, first.id, { status: 'done' })
  updateTask(db, second.id, { status: 'deferred', reason: 'needs_decision' })

  const accepted = acceptStage(db, { stageId: stage.id, actor: 'owner' })

  assert.equal(accepted.status, 'accepted')
})

test('undefer отказывает, если этап уже слит', () => {
  const { db, stage, first } = stageWithTwoTasks()
  updateTask(db, first.id, { status: 'deferred', reason: 'needs_decision' })
  db.prepare("update stages set status = 'merged' where id = ?").run(stage.id)

  assert.throws(() => undeferTask(db, { id: first.id, actor: 'owner' }), /уже слит/)
})
