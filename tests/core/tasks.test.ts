import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, type DatabaseSync } from '../../src/core/db.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { activateNextStage, addStage } from '../../src/core/stages.ts'
import {
  createTask,
  deferTask,
  editTask,
  getTask,
  openTasks,
  setTaskSession,
  undeferTask,
  updateTask,
} from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
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

test('заметка пишется при создании и правится', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  const task = createTask(db, { ...base, stageId, note: 'ключ в .env, без него тесты падают' })
  assert.equal(task.note, 'ключ в .env, без него тесты падают')
  assert.equal(getTask(db, task.id)!.note, 'ключ в .env, без него тесты падают', 'заметка переживает чтение')

  const edited = editTask(db, { id: task.id, actor: 'orchestrator', patch: { note: 'ключ берётся из sandbox' } })
  assert.equal(edited.note, 'ключ берётся из sandbox')
  assert.equal(getTask(db, task.id)!.note, 'ключ берётся из sandbox', 'правка заметки сохраняется')
})

test('пустая заметка не хранится и стирает прежнюю', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)

  const task = createTask(db, { ...base, stageId, note: '   ' })
  assert.equal(task.note, null, 'пробелы — это отсутствие заметки')

  editTask(db, { id: task.id, actor: 'orchestrator', patch: { note: 'важно' } })
  const cleared = editTask(db, { id: task.id, actor: 'orchestrator', patch: { note: '' } })
  assert.equal(cleared.note, null, 'пустая заметка стирает прежнюю')
})

test('createTask отказывает со списком ошибок', () => {  const db = openDb(':memory:')
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

test('миграция 14 добавляет заметку и не теряет задач', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  // откатываемся к схеме 13: колонки ещё нет
  db.exec('alter table tasks drop column note')
  db.prepare("update meta set value = '13' where key = 'schemaVersion'").run()

  assert.equal(migrate(db), SCHEMA_VERSION)
  assert.equal(getTask(db, id)!.id, id, 'задача на месте')
  assert.equal(getTask(db, id)!.note, null, 'колонка появилась пустой')
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

test('defer откладывает задачу с причиной и пишет событие', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  const deferred = deferTask(db, { id, actor: 'owner', reason: 'ждём доступ к API' })

  assert.equal(deferred.status, 'deferred')
  assert.equal(deferred.reason, 'ждём доступ к API', 'причина видна в задаче')
  assert.equal(getTask(db, id)!.status, 'deferred', 'статус переживает чтение')

  const event = db
    .prepare("select actor, note, after from events where type = 'task.deferred' order by id desc limit 1")
    .get() as { actor: string; note: string; after: string }
  assert.equal(event.actor, 'owner')
  assert.match(event.note, /доступ к API/)
  assert.match(event.after, /deferred/)
})

test('defer без причины отказывает и не меняет задачу', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  assert.throws(() => deferTask(db, { id, actor: 'owner', reason: '   ' }), /--reason/)
  assert.equal(getTask(db, id)!.status, 'open')
})

test('defer снимает аренду и не оставляет задачу в руке', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  db.prepare('insert into hand (executor_id, position, task_id, reserved_at) values (?, ?, ?, ?)').run(
    'w1',
    1,
    id,
    new Date().toISOString(),
  )

  const deferred = deferTask(db, { id, actor: 'owner', reason: 'ждём решения владельца' })

  assert.equal(deferred.holder, null)
  assert.equal(deferred.leaseUntil, null)
  const left = db.prepare('select count(*) as c from hand where task_id = ?').get(id) as { c: number }
  assert.equal(left.c, 0, 'из руки задача ушла')
  assert.throws(() => takeTask(db, { executor: 'w1', taskId: id, leaseMinutes: 30 }), /не готова: deferred/)
})

test('отложенная задача не считается открытой', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  const first = createTask(db, { ...base, stageId })
  const second = createTask(db, { ...base, stageId })

  deferTask(db, { id: first.id, actor: 'owner', reason: 'ждём' })

  assert.deepEqual(
    openTasks(db).map((task) => task.id),
    [second.id],
    'отложенная не в открытых',
  )
})

test('undefer возвращает задачу в работу через refreshReady', () => {
  const db = openDb(':memory:')
  const stageId = seed(db)
  activateNextStage(db, 'F1')
  const task = createTask(db, { ...base, stageId })
  refreshReady(db)
  assert.equal(getTask(db, task.id)!.status, 'ready', 'условие теста: задача была готова')

  deferTask(db, { id: task.id, actor: 'owner', reason: 'ждём' })
  refreshReady(db)
  assert.equal(getTask(db, task.id)!.status, 'deferred', 'refreshReady не воскрешает отложенную')

  const back = undeferTask(db, { id: task.id, actor: 'owner' })

  assert.equal(back.status, 'ready', 'задача снова готова к выдаче')
  assert.equal(back.reason, null, 'причина отложения снята')

  const event = db
    .prepare("select after from events where type = 'task.undeferred' order by id desc limit 1")
    .get() as { after: string }
  assert.match(event.after, /ready/)
})

test('undefer не отложенной задачи отказывает', () => {
  const db = openDb(':memory:')
  const id = seedTask(db)

  assert.throws(() => undeferTask(db, { id, actor: 'owner' }), /не отложена: open/)
})
