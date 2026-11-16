import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { allocateId, childId, slugify } from '../../src/core/ids.ts'

test('id монотонны и не переиспользуются', () => {
  const db = openDb(':memory:')
  assert.equal(allocateId(db, 'feature'), 'F1')
  assert.equal(allocateId(db, 'feature'), 'F2')
})

test('дочерние id читаемы', () => {
  assert.equal(childId('F7', 'stage', 2), 'F7.S2')
  assert.equal(childId('F7.S2', 'task', 3), 'F7.S2-3')
})

test('slug транслитерирует кириллицу', () => {
  assert.equal(slugify('Оплата подписки'), 'oplata-podpiski')
  assert.equal(slugify('Враг-стрелок «Босс»'), 'vrag-strelok-boss')
})
