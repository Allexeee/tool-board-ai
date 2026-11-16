import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { createTask, editTask, getTask, updateTask } from '../../src/core/tasks.ts'
import { validateTaskInput, type NewTask } from '../../src/core/validate.ts'

function seed(db: DatabaseSync): string {
  const request = addRequest(db, { title: 'Оплата', body: '...', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'Оплата', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  return stage.id
}

function seedTask(db: DatabaseSync): string {
  const stageId = seed(db)
  const task = createTask(db, { ...base, stageId })
  return task.id
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

test('task edit меняет поля и пишет before/after', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  const edited = editTask(db, {
    id,
    actor: 'orchestrator',
    patch: { dod: ['вебхук работает', 'тест покрывает отказ'], scope: ['src/billing/**', 'tests/**'] },
  })

  assert.deepEqual(edited.dod, ['вебхук работает', 'тест покрывает отказ'])
  assert.deepEqual(edited.scope, ['src/billing/**', 'tests/**'])

  const event = db
    .prepare("select before, after from events where type = 'task.edited' order by id desc limit 1")
    .get()
  assert.match(event.before, /src\/\*\*/)
  assert.match(event.after, /src\/billing/)
})

test('недопустимый размер отвергается и задача не меняется', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  assert.throws(() => editTask(db, { id, actor: 'orchestrator', patch: { size: 'XL' } }), /XL/)
  assert.equal(getTask(db, id)!.size, 'S')
})

test('правка без изменений не пишет событие', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  editTask(db, { id, actor: 'orchestrator', patch: { dod: ['вебхук принимает событие'] } })

  const count = db.prepare("select count(*) as c from events where type = 'task.edited'").get()
  assert.equal(count.c, 0)
})

test('держатель правит свою активную задачу', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)
  updateTask(db, id, { status: 'active', holder: 'w1' })

  const edited = editTask(db, { id, actor: 'w1', patch: { dod: ['новое условие'] } })

  assert.deepEqual(edited.dod, ['новое условие'])
  assert.equal(edited.holder, 'w1', 'правка не сбрасывает аренду')
})

test('посторонний исполнитель не правит чужую активную задачу', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)
  updateTask(db, id, { status: 'active', holder: 'w1' })

  assert.throws(() => editTask(db, { id, actor: 'w2', patch: { dod: ['чужое'] } }), /держит w1/)
  assert.deepEqual(getTask(db, id)!.dod, ['вебхук принимает событие'])
})

test('оркестратор правит любую задачу', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)
  updateTask(db, id, { status: 'active', holder: 'w1' })

  const edited = editTask(db, { id, actor: 'orchestrator', patch: { title: 'Уточнённый заголовок' } })

  assert.equal(edited.title, 'Уточнённый заголовок')
})
