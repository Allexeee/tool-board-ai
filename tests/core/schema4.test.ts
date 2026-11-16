import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, migrate } from '../../src/core/db.ts'

test('схема v4 добавляет идеи, решения, планы и review у задачи', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), 7)

  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  )
  for (const table of ['ideas', 'decisions', 'plans']) assert.ok(tables.includes(table), table)

  const columns = (db.prepare('pragma table_info(tasks)').all() as Array<{ name: string }>).map((c) => c.name)
  assert.ok(columns.includes('review'))
})
