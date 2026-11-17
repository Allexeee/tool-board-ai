import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { createTask, editTask, getTask, setTaskSession, updateTask } from '../../src/core/tasks.ts'
import { migrate, SCHEMA_VERSION } from '../../src/core/schema.ts'
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

test('scope через запятую разбирается на пути', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  const task = createTask(db, { ...base, stageId, scope: ['src/a,src/b', ' tests/** '] })

  assert.deepEqual(task.scope, ['src/a', 'src/b', 'tests/**'])
})

test('scope с запятой при правке тоже разбирается', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  const edited = editTask(db, { id, actor: 'orchestrator', patch: { scope: ['src/a,src/b'] } })

  assert.deepEqual(edited.scope, ['src/a', 'src/b'])
})

test('одиночный exclusive остаётся эксклюзивной областью', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  const task = createTask(db, { ...base, stageId, scope: [' exclusive '] })

  assert.equal(task.scope, 'exclusive')
})

test('задача помнит сессию и стирает её', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  assert.equal(getTask(db, id)!.session, null, 'у новой задачи сессии нет')

  const bound = setTaskSession(db, { id, session: ' ses_42 ', actor: 'w1' })
  assert.equal(bound.session, 'ses_42')
  assert.equal(getTask(db, id)!.session, 'ses_42', 'сессия переживает чтение')

  const cleared = setTaskSession(db, { id, session: null, actor: 'owner' })
  assert.equal(cleared.session, null)
  assert.equal(getTask(db, id)!.session, null)
})

test('смена сессии пишется в журнал', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  setTaskSession(db, { id, session: 'ses_1', actor: 'w1' })
  setTaskSession(db, { id, session: null, actor: 'owner' })

  const bound = db
    .prepare("select actor, after from events where type = 'task.session_bound'")
    .get() as { actor: string; after: string }
  assert.equal(bound.actor, 'w1')
  assert.match(bound.after, /ses_1/)

  const reset = db
    .prepare("select before from events where type = 'task.session_reset'")
    .get() as { before: string }
  assert.match(reset.before, /ses_1/)
})

test('пустая сессия отвергается, прежняя остаётся', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)
  setTaskSession(db, { id, session: 'ses_1', actor: 'w1' })

  assert.throws(() => setTaskSession(db, { id, session: '   ', actor: 'w1' }), /--session/)
  assert.equal(getTask(db, id)!.session, 'ses_1')
})

test('задача без сессии не считается изменённой', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  setTaskSession(db, { id, session: null, actor: 'owner' })

  const count = db
    .prepare("select count(*) as c from events where type like 'task.session%'")
    .get() as { c: number }
  assert.equal(count.c, 0, 'сброс и так пустой сессии не пишет событие')
})

test('миграция 9 добавляет сессию и не теряет задач', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  // откатываемся к схеме 8: колонки и триггера ещё нет
  db.exec('drop trigger if exists trg_stage_merged_clears_task_sessions')
  db.exec('alter table tasks drop column session')
  db.prepare("update meta set value = '8' where key = 'schemaVersion'").run()

  assert.equal(migrate(db), SCHEMA_VERSION)
  assert.equal(getTask(db, id)!.id, id, 'задача на месте')
  assert.equal(getTask(db, id)!.session, null, 'колонка появилась пустой')
})

test('слияние этапа стирает сессии его задач', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const task = createTask(db, { ...base, stageId })
  const neighbourStage = addStage(db, { featureId: 'F1', name: 'S2', goal: 'g', appetite: '1 день' })
  const neighbour = createTask(db, { ...base, stageId: neighbourStage.id })

  setTaskSession(db, { id: task.id, session: 'ses_1', actor: 'w1' })
  setTaskSession(db, { id: neighbour.id, session: 'ses_2', actor: 'w1' })

  db.prepare("update stages set status = 'merged' where id = ?").run(stageId)

  assert.equal(getTask(db, task.id)!.session, null, 'слитый этап забывает сессию')
  assert.equal(getTask(db, neighbour.id)!.session, 'ses_2', 'соседний этап не тронут')
})
