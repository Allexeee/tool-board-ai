import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { listTemplates, saveTemplate, showTemplate, similarFeatures } from '../../src/core/templates.ts'

function featureWithStages() {
  const db = openDb(':memory:')
  const feature = addFeature(db, { name: 'Оплата подписки', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'Каркас', goal: 'можно заплатить', appetite: '3 дня' })
  activateNextStage(db, feature.id)
  createTask(db, {
    stageId: stage.id,
    title: 'Подключить SDK',
    dod: ['клиент создаётся'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  return { db, feature }
}

test('шаблон сохраняется из фичи и читается', () => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-'))
  const { db, feature } = featureWithStages()

  const path = saveTemplate(root, { name: 'content-pack', featureId: feature.id, db })
  assert.ok(existsSync(path))
  assert.match(showTemplate(root, 'content-pack'), /Каркас/)
  assert.deepEqual(listTemplates(root), ['content-pack'])
})

test('имя шаблона проверяется', () => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-'))
  const { db, feature } = featureWithStages()
  assert.throws(() => saveTemplate(root, { name: 'Плохое имя', featureId: feature.id, db }), /имя/)
})

test('шаблон из несуществующей фичи не создаётся', () => {
  const root = mkdtempSync(join(tmpdir(), 'tpl-'))
  const db = openDb(':memory:')
  assert.throws(() => saveTemplate(root, { name: 'x', featureId: 'F99', db }), /не найдена/)
})

test('похожие фичи находятся по словам', () => {
  const { db, feature } = featureWithStages()
  assert.equal(similarFeatures(db, 'оплата')[0].id, feature.id)
  assert.equal(similarFeatures(db, 'маркетинг').length, 0)
})
