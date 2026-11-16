import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'

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
