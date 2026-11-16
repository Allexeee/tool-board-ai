import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { createTask } from '../../src/core/tasks.ts'
import { listFeatures } from '../../src/core/features.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { isReady } from '../../src/core/deps.ts'

const base = {
  title: 'Поправить опечатку',
  dod: ['опечатки нет'],
  size: 'XS' as const,
  skill: 'backend',
  class: 'quick' as const,
  scope: ['docs/**'],
}

test('задача без этапа получает идентификатор T1', () => {
  const db = openDb(':memory:')
  const task = createTask(db, { ...base })

  assert.equal(task.id, 'T1')
  assert.equal(task.stageId, null)
  assert.equal(task.status, 'open')
})

test('второй задача пула получает T2', () => {
  const db = openDb(':memory:')
  createTask(db, { ...base })
  assert.equal(createTask(db, { ...base }).id, 'T2')
})

test('задача пула не участвует в готовности фичи', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  createTask(db, { ...base })
  const tasks = db.prepare('select id from tasks where stage_id is null').all() as Array<{ id: string }>

  assert.equal(tasks.length, 1)
  assert.equal(listFeatures(db).length, 1)
  assert.equal(isReady(db, 'T1'), true)
})
