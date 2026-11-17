import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate } from '../../src/core/db.ts'
import { getExecutor } from '../../src/core/executors.ts'

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

test('миграция 7 → 8 добавляет модель, права и шаги без потери исполнителей', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-v7-'))
  const path = join(dir, 'tracker.db')
  const old = openDb(path)

  // приводим таблицу исполнителей к виду схемы 7
  old.exec('alter table executors drop column model')
  old.exec('alter table executors drop column permissions')
  old.exec('alter table executors drop column steps')
  old
    .prepare(
      'insert into executors (id, kind, skills, wip_limit, hand_size, session, last_seen) values (?, ?, ?, ?, ?, ?, ?)',
    )
    .run('w1', 'agent', JSON.stringify(['backend', 'design']), 2, 4, 'ses_old', '2026-01-01T00:00:00.000Z')
  old.prepare("update meta set value = '7' where key = 'schemaVersion'").run()
  old.close()

  assert.throws(() => openDb(path), /устарела/)

  const db = openDb(path, { allowOutdated: true })
  assert.equal(migrate(db), 8)

  const version = db.prepare("select value from meta where key = 'schemaVersion'").get() as { value: string }
  assert.equal(Number(version.value), 8)

  const executor = getExecutor(db, 'w1')
  assert.ok(executor, 'исполнитель пережил миграцию')
  assert.deepEqual(executor!.skills, ['backend', 'design'])
  assert.equal(executor!.wipLimit, 2)
  assert.equal(executor!.handSize, 4)
  assert.equal(executor!.session, 'ses_old')
  assert.equal(executor!.lastSeen, '2026-01-01T00:00:00.000Z')
  assert.equal(executor!.model, null)
  assert.deepEqual(executor!.permissions, [])
  assert.equal(executor!.steps, 20)
  db.close()
})
