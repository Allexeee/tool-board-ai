import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

test('шаг, проверяемый тестом, требует tests в области', () => {
  const { plan } = fixture([{ ...step, dod: ['тест покрывает отказ'], scope: ['src/**'] }])

  assert.match(validatePlan(plan).join('\n'), /Каркас\/1: шаг проверяется тестом — добавьте tests\/ в область/)
})

test('шаг с tests в области проходит', () => {
  const { plan } = fixture([{ ...step, dod: ['тест покрывает отказ'], scope: ['src/**', 'tests/**'] }])

  assert.doesNotMatch(validatePlan(plan).join('\n'), /tests/)
})

test('шаг без упоминания теста не проверяется', () => {
  const { plan } = fixture([{ ...step, dod: ['клиент создаётся'], scope: ['src/**'] }])

  assert.doesNotMatch(validatePlan(plan).join('\n'), /tests/)
})

test('задачи плана создаются без ревью', () => {
  const { db, request } = fixture()
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })

  const result = applyPlan(db, { requestId: request.id })
  assert.equal(result.tasks[0].review, 'none')
})

test('закрытый запрос применить нельзя', () => {
  const { db, request } = fixture()
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })
  db.prepare("update requests set status = 'closed' where id = ?").run(request.id)

  assert.throws(() => applyPlan(db, { requestId: request.id }), /закрыт/)
})

test('второй план по запросу не применяется', () => {
  const { db, request } = fixture()
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })
  applyPlan(db, { requestId: request.id })

  const plan = addPlan(db, { requestId: request.id, title: 'Второй', assumptions: [], stages: [{ name: 'E', goal: 'g', appetite: '1 день', steps: [step] }] })
  approvePlan(db, { requestId: request.id, version: plan.version, actor: 'owner' })

  assert.throws(() => applyPlan(db, { requestId: request.id, version: plan.version }), /уже есть фича/)
})

test('устаревший план требует переутверждения', () => {
  const { db, request } = fixture()
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })
  db.prepare('update plans set stale_at = ? where request_id = ?').run(new Date().toISOString(), request.id)

  assert.throws(() => applyPlan(db, { requestId: request.id }), /устарел/)
})

test('validatePlan отвергает абсолютный путь и выход из проекта', () => {
  const root = mkdtempSync(join(tmpdir(), 'al-plan-fs-'))
  const { plan } = fixture([{ ...step, scope: ['/etc/passwd'] }])
  assert.match(validatePlan(plan, { root }).join('\n'), /относительной/)

  const escape = fixture([{ ...step, scope: ['../outside/**'] }])
  assert.match(validatePlan(escape.plan, { root }).join('\n'), /выходить за проект/)
})

test('validatePlan ловит несуществующий родительский каталог', () => {
  const root = mkdtempSync(join(tmpdir(), 'al-plan-fs2-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const { plan } = fixture([{ ...step, scope: ['src/nope/deep/x.ts'] }])

  assert.match(validatePlan(plan, { root }).join('\n'), /не существует/)
})

test('новый файл в существующем каталоге проходит', () => {
  const root = mkdtempSync(join(tmpdir(), 'al-plan-fs3-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const { plan } = fixture([{ ...step, scope: ['src/new-file.ts'] }])

  assert.doesNotMatch(validatePlan(plan, { root }).join('\n'), /не существует/)
})

test('каталог, объявленный предыдущим шагом, не считается отсутствующим', () => {
  const root = mkdtempSync(join(tmpdir(), 'al-plan-fs4-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const { plan } = fixture([
    { ...step, title: 'Создать хранилище', scope: ['src/store/**'] },
    { ...step, title: 'Добавить адаптер', scope: ['src/store/adapter.ts'], deps: [0] },
  ])

  const errors = validatePlan(plan, { root }).join('\n')
  assert.doesNotMatch(errors, /не существует/, errors)
})

test('опечатка в каталоге по-прежнему ловится, даже если есть предыдущий шаг', () => {
  const root = mkdtempSync(join(tmpdir(), 'al-plan-fs5-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  const { plan } = fixture([
    { ...step, title: 'Создать хранилище', scope: ['src/store/**'] },
    { ...step, title: 'Опечатка', scope: ['src/stroe/adapter.ts'], deps: [0] },
  ])

  assert.match(validatePlan(plan, { root }).join('\n'), /src\/stroe не существует/)
})

