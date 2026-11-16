import { DatabaseSync } from 'node:sqlite'
import { migrate, schemaVersionOf, SCHEMA_VERSION } from './schema.ts'
import { UserError } from '../cli/errors.ts'

export { migrate } from './schema.ts'

const depth = new WeakMap<DatabaseSync, number>()

export function openDb(path: string, options: { allowOutdated?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma busy_timeout = 5000')
  db.exec('pragma foreign_keys = on')

  const version = schemaVersionOf(db)

  if (version === 0) {
    migrate(db)
    return db
  }

  if (version < SCHEMA_VERSION && !options.allowOutdated) {
    throw new UserError(
      3,
      `схема ${version} устарела (нужна ${SCHEMA_VERSION}): выполните toolbox-al upgrade --yes`,
    )
  }

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
