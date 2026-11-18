import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate } from '../../src/core/db.ts'
import { SCHEMA_VERSION } from '../../src/core/schema.ts'
import { getExecutor } from '../../src/core/executors.ts'
import { getTask } from '../../src/core/tasks.ts'

function oldDb() {
  const dir = mkdtempSync(join(tmpdir(), 'al-old-'))
  const path = join(dir, 'tracker.db')
  const db = openDb(path)
  db.prepare("update meta set value = '1' where key = 'schemaVersion'").run()
  db.close()
  return path
}

test('устаревшая схема не мигрирует молча', () => {
  const path = oldDb()
  assert.throws(() => openDb(path), /устарела/)
})

test('с allowOutdated открывается без миграции', () => {
  const path = oldDb()
  const db = openDb(path, { allowOutdated: true })

  const row = db.prepare("select value from meta where key = 'schemaVersion'").get() as { value: string }
  assert.equal(Number(row.value), 1)
})

test('новая база создаётся сразу на текущей схеме', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-new-'))
  const db = openDb(join(dir, 'tracker.db'))

  const row = db.prepare("select value from meta where key = 'schemaVersion'").get() as { value: string }
  assert.ok(Number(row.value) > 0)
})

test('миграция 7 → 10 добавляет модель, права, шаги, сессию задачи и прогоны без потери исполнителей', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-v7-'))
  const path = join(dir, 'tracker.db')
  const old = openDb(path)

  // приводим базу к виду схемы 7: у исполнителя нет модели, прав и шага,
  // у задачи нет сессии — её сторожит триггер слияния этапа.
  // spec тоже убираем: колонка приходит миграцией 12
  old.exec('alter table executors drop column model')
  old.exec('alter table executors drop column permissions')
  old.exec('alter table executors drop column steps')
  old.exec('drop trigger if exists trg_stage_merged_clears_task_sessions')
  old.exec('alter table tasks drop column session')
  old.exec('alter table tasks drop column spec')
  old
    .prepare(
      'insert into executors (id, kind, skills, wip_limit, hand_size, session, last_seen) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run('w1', 'agent', JSON.stringify(['backend', 'design']), 2, 4, 'ses_old', '2026-01-01T00:00:00.000Z')
  old.prepare("update meta set value = '7' where key = 'schemaVersion'").run()
  old.close()

  assert.throws(() => openDb(path), /устарела/)

  const db = openDb(path, { allowOutdated: true })
  assert.equal(migrate(db), SCHEMA_VERSION)

  const version = db.prepare("select value from meta where key = 'schemaVersion'").get() as { value: string }
  assert.equal(Number(version.value), SCHEMA_VERSION)

  const executor = getExecutor(db, 'w1')
  assert.ok(executor, 'исполнитель пережил миграцию')
  assert.deepEqual(executor!.skills, ['backend', 'design'])
  assert.equal(executor!.wipLimit, 2)
  assert.equal(executor!.handSize, 4)
  assert.equal(executor!.session, 'ses_old')
  assert.equal(executor!.lastSeen, '2026-01-01T00:00:00.000Z')
  assert.equal(executor!.model, null)
  assert.deepEqual(executor!.permissions, [])
  assert.equal(executor!.steps, 60, 'старый дефолт 20 поднят миграцией')

  // схема 9 вернула сессию задачи и сторожевой триггер
  const column = db.prepare("select 1 as found from pragma_table_info('tasks') where name = 'session'").get()
  assert.ok(column, 'у задачи снова есть колонка session')
  const trigger = db
    .prepare("select 1 as found from sqlite_master where type = 'trigger' and name = 'trg_stage_merged_clears_task_sessions'")
    .get()
  assert.ok(trigger, 'триггер сброса сессий на месте')

  // схема 10 добавила прогон: таблица runs
  const runs = db.prepare("select 1 as found from sqlite_master where type = 'table' and name = 'runs'").get()
  assert.ok(runs, 'прогоны лежат в базе')
  db.close()
})

test('миграция 11 → 12 добавляет спеку задачи и сохраняет задачи', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-v11-'))
  const path = join(dir, 'tracker.db')
  const old = openDb(path)

  // приводим базу к схеме 11: колонки spec ещё нет
  old.exec('alter table tasks drop column spec')
  old
    .prepare(
      'insert into tasks (id, title, dod, size, skill, class, scope, status, created_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      'T1',
      'Живая задача',
      JSON.stringify(['сделано']),
      'S',
      'backend',
      'standard',
      JSON.stringify(['src/**']),
      'open',
      '2026-01-01T00:00:00.000Z',
    )
  old.prepare("update meta set value = '11' where key = 'schemaVersion'").run()
  old.close()

  assert.throws(() => openDb(path), /устарела/)

  const db = openDb(path, { allowOutdated: true })
  assert.equal(migrate(db), SCHEMA_VERSION)

  const column = db.prepare("select 1 as found from pragma_table_info('tasks') where name = 'spec'").get()
  assert.ok(column, 'у задачи есть колонка spec')

  const task = getTask(db, 'T1')
  assert.ok(task, 'задача пережила миграцию')
  assert.equal(task!.title, 'Живая задача')
  const spec = db.prepare('select spec from tasks where id = ?').get('T1') as { spec: string | null }
  assert.equal(spec.spec, null, 'у старых задач спеки нет — колонка пустая, а не потерянная')
  db.close()
})
