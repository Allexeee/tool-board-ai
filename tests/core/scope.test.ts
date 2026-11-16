import test from 'node:test'
import assert from 'node:assert/strict'
import { scopesOverlap } from '../../src/core/git/scope.ts'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'

test('exclusive пересекается со всем', () => {
  assert.equal(scopesOverlap('exclusive', ['src/a']), true)
  assert.equal(scopesOverlap(['src/a'], 'exclusive'), true)
})

test('разные каталоги не пересекаются', () => {
  assert.equal(scopesOverlap(['assets/sprites/**'], ['src/enemy/**']), false)
})

test('вложенный путь пересекается', () => {
  assert.equal(scopesOverlap(['src/**'], ['src/billing/a.ts']), true)
})

test('вторая задача с пересечением не берётся', () => {
  const db: DatabaseSync = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'] })

  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  const base = {
    stageId: stage.id,
    dod: ['a'],
    size: 'S' as const,
    skill: 'backend',
    class: 'standard' as const,
  }
  const first = createTask(db, { ...base, title: 'Первый шаг', scope: ['src/billing/**'] })
  const second = createTask(db, { ...base, title: 'Второй шаг', scope: ['src/billing/api.ts'] })
  refreshReady(db)

  takeTask(db, { executor: 'w1', taskId: first.id })
  assert.throws(() => takeTask(db, { executor: 'w2', taskId: second.id }), /област/)
})
