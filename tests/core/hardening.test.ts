import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { saveTemplate, showTemplate } from '../../src/core/templates.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addPlan, approvePlan, type PlanStage } from '../../src/core/plans.ts'
import { applyPlan } from '../../src/core/apply.ts'
import { listStages } from '../../src/core/stages.ts'

test('имя шаблона при чтении проверяется, выход из каталога запрещён', () => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-'))
  const db = openDb(':memory:')
  const feature = addFeature(db, { name: 'A', rank: 1 })
  addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  saveTemplate(root, { name: 'ok', featureId: feature.id, db })

  assert.throws(() => showTemplate(root, '../config'), /имя/)
  assert.throws(() => showTemplate(root, '../../etc/passwd'), /имя/)
})

test('политика приёмки из плана попадает в этап', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const stages: PlanStage[] = [
    {
      name: 'S1',
      goal: 'g',
      appetite: '2 дня',
      acceptance: 'owner',
      steps: [{ title: 'Шаг', skill: 'backend', size: 'S', dod: ['a'], scope: ['src/**'] }],
    },
  ]
  addPlan(db, { requestId: request.id, title: 'A', assumptions: [], stages })
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })

  const result = applyPlan(db, { requestId: request.id })
  assert.equal(listStages(db, result.feature.id)[0].acceptance, 'owner')
})

test('зависимость на несуществующий индекс отвергается', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const stages: PlanStage[] = [
    {
      name: 'S1',
      goal: 'g',
      appetite: '2 дня',
      steps: [{ title: 'Шаг', skill: 'backend', size: 'S', dod: ['a'], scope: ['src/**'], deps: [5] }],
    },
  ]
  addPlan(db, { requestId: request.id, title: 'A', assumptions: [], stages })
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })

  assert.throws(() => applyPlan(db, { requestId: request.id }), /зависим/)
})
