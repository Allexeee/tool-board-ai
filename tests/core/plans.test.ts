import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addPlan, approvePlan, getPlan, markPlansStale, type PlanStage } from '../../src/core/plans.ts'

const stagesFixture: PlanStage[] = [
  {
    name: 'Каркас',
    goal: 'можно заплатить',
    appetite: '3 дня',
    steps: [
      { title: 'Подключить SDK', skill: 'backend', size: 'S', dod: ['клиент создаётся'], scope: ['src/**'] },
      { title: 'Страница оплаты', skill: 'frontend', size: 'M', dod: ['форма работает'], scope: ['ui/**'] },
    ],
  },
]

test('версии плана растут, старая остаётся неизменной', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })

  const v1 = addPlan(db, { requestId: request.id, title: 'Оплата', assumptions: ['карты'], stages: stagesFixture })
  const v2 = addPlan(db, { requestId: request.id, title: 'Оплата', assumptions: [], stages: stagesFixture })

  assert.equal(v1.version, 1)
  assert.equal(v2.version, 2)
  assert.deepEqual(getPlan(db, { requestId: request.id, version: 1 })!.assumptions, ['карты'])
  assert.equal(getPlan(db, { requestId: request.id })!.version, 2)
})

test('утверждённый план фиксирует автора и время', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  addPlan(db, { requestId: request.id, title: 'Оплата', assumptions: [], stages: stagesFixture })

  const plan = approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })
  assert.ok(plan.approvedAt)
  assert.equal(plan.approvedBy, 'owner')
  assert.throws(() => approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' }), /уже/)
})
