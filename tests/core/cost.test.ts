import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, editTask, getTask } from '../../src/core/tasks.ts'
import { appendEvent } from '../../src/core/events.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { featureCost } from '../../src/core/cost.ts'

function fixture() {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
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
  const first = createTask(db, { ...base, title: 'Первая' })
  const second = createTask(db, { ...base, title: 'Вторая' })
  refreshReady(db)
  return { db, feature, first, second }
}

test('feature cost считает задачи, правки, переоткрытия и блокировки', () => {
  const { db, feature, first, second } = fixture()

  editTask(db, { id: first.id, actor: 'w1', patch: { title: 'Первая, уточнённая' } })
  editTask(db, { id: first.id, actor: 'w1', patch: { title: 'Первая, ещё раз' } })
  appendEvent(db, { type: 'task.reopened', actor: 'owner', subject: second.id })
  appendEvent(db, { type: 'task.blocked', actor: 'w1', subject: second.id, note: 'needs_decision' })

  const cost = featureCost(db, feature.id)

  assert.equal(cost.tasks, 2)
  assert.equal(cost.edits, 2)
  assert.equal(cost.reopens, 1)
  assert.equal(cost.blocks, 1)
  assert.equal(cost.done, 0)
  assert.ok(cost.firstAt && cost.lastAt, 'срок считается по событиям')
})

test('feature cost не падает на фиче без событий', () => {
  const { db, feature } = fixture()
  db.prepare('delete from events').run()

  const cost = featureCost(db, feature.id)

  assert.equal(cost.tasks, 2)
  assert.equal(cost.edits, 0)
  assert.equal(cost.hours, 0)
  assert.equal(getTask(db, 'F1.S1-1')!.title, 'Первая')
})
