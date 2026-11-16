import test from 'node:test'
import assert from 'node:assert/strict'
import { mergedReadyFixture } from '../git/merge.test.ts'
import { acceptStage, rejectStage } from '../../src/core/accept.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage, getStage } from '../../src/core/stages.ts'
import { createTask, getTask, updateTask } from '../../src/core/tasks.ts'
import { openDb } from '../../src/core/db.ts'
import { mergeStage } from '../../src/core/git/merge.ts'

test('этап с приёмкой владельца не сливается без приёмки', () => {
  const { root, db, config, stage } = mergedReadyFixture({ acceptance: 'owner' })

  const blocked = mergeStage(db, { root, stageId: stage.id, config })
  assert.equal(blocked.merged, false)
  assert.match(blocked.reason ?? '', /принят/)

  acceptStage(db, { stageId: stage.id, actor: 'owner' })
  assert.equal(mergeStage(db, { root, stageId: stage.id, config }).merged, true)
})

test('возврат этапа переоткрывает задачи', () => {
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
    review: 'owner',
  })
  updateTask(db, task.id, { status: 'in_review' })

  rejectStage(db, { stageId: stage.id, actor: 'owner', reason: 'не то' })

  assert.equal(getStage(db, stage.id)!.status, 'active')
  assert.equal(getTask(db, task.id)!.status, 'ready')
})
