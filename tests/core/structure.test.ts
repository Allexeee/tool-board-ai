import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest, listRequests } from '../../src/core/requests.ts'
import { addFeature, listFeatures, rankFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage, listStages } from '../../src/core/stages.ts'

test('ранг переставляется без дыр', () => {
  const db = openDb(':memory:')
  const r = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const f1 = addFeature(db, { requestId: r.id, name: 'A', rank: 1 })
  const f2 = addFeature(db, { requestId: r.id, name: 'B', rank: 2 })
  const f3 = addFeature(db, { requestId: r.id, name: 'C', rank: 3 })

  rankFeature(db, f3.id, 1)

  assert.deepEqual(listFeatures(db).map((f) => [f.id, f.rank]), [[f3.id, 1], [f1.id, 2], [f2.id, 3]])
})

test('этапы нумеруются подряд и активируются по одному', () => {
  const db = openDb(':memory:')
  const r = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const f = addFeature(db, { requestId: r.id, name: 'A', rank: 1 })
  const s1 = addStage(db, { featureId: f.id, name: 'S1', goal: 'g' })
  const s2 = addStage(db, { featureId: f.id, name: 'S2', goal: 'g' })

  assert.equal(s2.seq, 2)
  assert.equal(activateNextStage(db, f.id)!.id, s1.id)
  assert.equal(activateNextStage(db, f.id), null)
  assert.deepEqual(listStages(db, f.id).map((s) => s.status), ['active', 'planned'])
})

test('запрос создаётся в inbox', () => {
  const db = openDb(':memory:')
  addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  assert.equal(listRequests(db)[0].status, 'inbox')
})
