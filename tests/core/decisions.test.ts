import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addDecision, listDecisions } from '../../src/core/decisions.ts'

test('решение хранит альтернативы и связь с фичей', () => {
  const db = openDb(':memory:')
  const decision = addDecision(db, {
    question: 'какой провайдер',
    choice: 'ЮKassa',
    alternatives: ['Stripe'],
    reason: 'у клиента договор',
    subjectId: 'F1',
    author: 'owner',
  })

  assert.deepEqual(decision.alternatives, ['Stripe'])
  assert.equal(listDecisions(db, { subjectId: 'F1' })[0].id, decision.id)
  assert.equal(listDecisions(db, { subjectId: 'F2' }).length, 0)
})
