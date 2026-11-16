import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest, getRequest } from '../../src/core/requests.ts'
import { listFeatures } from '../../src/core/features.ts'
import { addPlan, approvePlan, type PlanStage, type PlanStep } from '../../src/core/plans.ts'
import { applyPlan, validatePlan } from '../../src/core/apply.ts'

const step: PlanStep = {
  title: 'Подключить SDK',
  skill: 'backend',
  size: 'S',
  dod: ['клиент создаётся'],
  scope: ['src/**'],
}

function fixture(steps: PlanStep[] = [step, { ...step, title: 'Страница оплаты', skill: 'frontend' }]) {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  const stages: PlanStage[] = [{ name: 'Каркас', goal: 'можно заплатить', appetite: '3 дня', steps }]
  const plan = addPlan(db, { requestId: request.id, title: 'Оплата', assumptions: [], stages })
  return { db, request, plan }
}

test('неполный шаг не даёт применить план', () => {
  const { db, request, plan } = fixture([{ ...step, dod: [], scope: [] }])
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })

  assert.match(validatePlan(plan).join('\n'), /DoD/)
  assert.throws(() => applyPlan(db, { requestId: request.id }), /DoD/)
  assert.equal(listFeatures(db).length, 0)
})

test('применённый план создаёт фичу, этап и задачи', () => {
  const { db, request } = fixture()
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })

  const result = applyPlan(db, { requestId: request.id })
  assert.equal(result.feature.name, 'Оплата')
  assert.equal(result.stages.length, 1)
  assert.equal(result.tasks.length, 2)
  assert.equal(getRequest(db, request.id)!.status, 'planned')
})

test('второй apply отвергается', () => {
  const { db, request } = fixture()
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })
  applyPlan(db, { requestId: request.id })
  assert.throws(() => applyPlan(db, { requestId: request.id }), /уже примен/)
})

test('XL в плане отвергается', () => {
  const { plan } = fixture([{ ...step, size: 'XL' as never }])
  assert.match(validatePlan(plan).join(' '), /XL/)
})

test('scope из плана с запятой разбирается на пути', () => {
  const { db, request } = fixture([{ ...step, scope: ['src/a,src/b'] }])
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })

  const result = applyPlan(db, { requestId: request.id })
  assert.deepEqual(result.tasks[0].scope, ['src/a', 'src/b'])
})

test('неутверждённый план не применяется', () => {
  const { db, request } = fixture()
  assert.throws(() => applyPlan(db, { requestId: request.id }), /утвержд/)
})

test('deps вне этапа даёт ошибку с номером шага', () => {
  const { plan } = fixture([{ ...step, deps: [5] }, { ...step, title: 'Второй' }])

  const errors = validatePlan(plan).join('\n')
  assert.match(errors, /Каркас\/1: зависимость 5 вне этапа/)
})

test('deps на самого себя отвергается', () => {
  const { plan } = fixture([{ ...step, deps: [0] }])

  assert.match(validatePlan(plan).join('\n'), /Каркас\/1: зависимость на самого себя/)
})

test('корректные deps проходят проверку и план применяется', () => {
  const { db, request } = fixture([{ ...step, deps: [1] }, { ...step, title: 'Второй' }])
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })

  const result = applyPlan(db, { requestId: request.id })
  assert.equal(result.tasks.length, 2)
})
