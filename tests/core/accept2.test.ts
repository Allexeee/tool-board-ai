import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage, getStage } from '../../src/core/stages.ts'
import { createTask, updateTask } from '../../src/core/tasks.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { acceptStage, rejectStage } from '../../src/core/accept.ts'
import { reopenTask } from '../../src/core/done.ts'

test('нельзя вернуть уже слитый этап', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  db.prepare("update stages set status = 'merged' where id = ?").run(stage.id)

  assert.throws(() => rejectStage(db, { stageId: stage.id, actor: 'owner', reason: 'x' }), /слит|нельзя/)
  assert.equal(getStage(db, stage.id)!.status, 'merged')
})

test('возврат задачи снимает приёмку этапа', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  const task = createTask(db, {
    stageId: stage.id,
    title: 'Добавить вебхук',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  updateTask(db, task.id, { status: 'done' })

  acceptStage(db, { stageId: stage.id, actor: 'owner' })
  reopenTask(db, { taskId: task.id, actor: 'owner', reason: 'плохо' })

  assert.equal(getStage(db, stage.id)!.status, 'active')
})
