import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, updateTask } from '../../src/core/tasks.ts'
import { appendEvent } from '../../src/core/events.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { formatWeek, reviewWeek } from '../../src/core/week.ts'

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
    scope: ['src/**'],
  }
  const first = createTask(db, { ...base, title: 'Обычная', class: 'standard' })
  const second = createTask(db, { ...base, title: 'Срочная', class: 'expedite' })
  refreshReady(db)

  return { db, feature, first, second }
}

test('review week считает переоткрытия, блокировки и срочные', () => {
  const { db, feature, first, second } = fixture()
  updateTask(db, first.id, { status: 'done' })
  appendEvent(db, { type: 'task.reopened', actor: 'owner', subject: first.id })
  appendEvent(db, { type: 'task.blocked', actor: 'w1', subject: second.id, note: 'needs_decision' })

  const report = reviewWeek(db, { days: 7 })
  const row = report.features.find((item) => item.featureId === feature.id)!

  assert.equal(row.tasks, 2)
  assert.equal(row.done, 1)
  assert.equal(row.reopens, 1)
  assert.equal(row.blocks, 1)
  assert.equal(row.urgent, 1)
  assert.equal(report.totals.urgentShare, 50)
  assert.match(formatWeek(report), /срочных: 50%/)
})

test('review week молчит, когда работы не было', () => {
  const { db } = fixture()
  const report = reviewWeek(db, { days: 7, now: new Date('2030-01-01T00:00:00.000Z') })

  assert.deepEqual(report.features, [])
  assert.match(formatWeek(report), /работы не было/)
})
