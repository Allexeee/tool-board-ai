import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, migrate } from '../../src/core/db.ts'

test('схема v5 добавляет рутины, шаги, прогоны и гейты', () => {
  const db = openDb(':memory:')
  assert.equal(migrate(db), 5)

  const tables = (db.prepare("select name from sqlite_master where type='table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  )
  for (const table of ['routines', 'routine_steps', 'routine_runs', 'gates']) {
    assert.ok(tables.includes(table), table)
  }
})
