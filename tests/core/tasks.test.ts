import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { validateTaskInput, type NewTask } from '../../src/core/validate.ts'

function seed(db: DatabaseSync): string {
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'Оплата', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  return stage.id
}

const base: NewTask = {
  stageId: 'F1.S1',
  title: 'Добавить вебхук подтверждения',
  dod: ['вебхук принимает событие'],
  size: 'S',
  skill: 'backend',
  class: 'standard',
  scope: ['src/**'],
}

test('задача без DoD не создаётся', () => {
  const { errors } = validateTaskInput({ ...base, dod: [] })
  assert.match(errors.join('\n'), /DoD/)
})

test('XL отвергается, L требует причины', () => {
  assert.match(validateTaskInput({ ...base, size: 'XL' as never }).errors.join(' '), /XL/)
  assert.match(validateTaskInput({ ...base, size: 'L' }).errors.join(' '), /причин/)
})

test('заголовок-тема даёт предупреждение, но не отказ', () => {
  const result = validateTaskInput({ ...base, title: 'Оплата' })
  assert.equal(result.errors.length, 0)
  assert.equal(result.warnings.length, 1)
})

test('созданная задача получает статус open и id вида F1.S1-1', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const task = createTask(db, { ...base, stageId })
  assert.equal(task.status, 'open')
  assert.equal(task.id, 'F1.S1-1')
})

test('createTask отказывает со списком ошибок', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  assert.throws(() => createTask(db, { ...base, stageId, dod: [] }), /DoD/)
})

test('дефект без severity не создаётся', () => {
  const result = validateTaskInput({ ...base, kind: 'defect' })
  assert.match(result.errors.join('\n'), /severity/)
})

test('severity сохраняется у дефекта', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const task = createTask(db, { ...base, stageId, kind: 'defect', severity: 'S2' })
  assert.equal(task.severity, 'S2')
})
