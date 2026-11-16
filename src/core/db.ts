import { DatabaseSync } from 'node:sqlite'
import { migrate } from './schema.ts'

export { migrate } from './schema.ts'

const depth = new WeakMap<DatabaseSync, number>()

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma busy_timeout = 5000')
  db.exec('pragma foreign_keys = on')
  migrate(db)
  return db
}

export function tx<T>(db: DatabaseSync, fn: () => T): T {
  const active = depth.get(db) ?? 0
  if (active > 0) return fn()

  depth.set(db, 1)
  db.exec('begin immediate')
  try {
    const result = fn()
    db.exec('commit')
    return result
  } catch (error) {
    db.exec('rollback')
    throw error
  } finally {
    depth.set(db, 0)
  }
}
