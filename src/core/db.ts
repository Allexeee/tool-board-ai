import { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { migrate, schemaVersionOf, SCHEMA_VERSION } from './schema.ts'

export { migrate } from './schema.ts'

const depth = new WeakMap<DatabaseSync, number>()

export interface OpenDbOptions {
  /** Не мигрировать устаревшую схему: открыть как есть (нужно doctor). */
  allowOutdated?: boolean
  /** Не бросать на более новой схеме: открыть как есть (нужно doctor). */
  allowNewer?: boolean
}

export function openDb(path: string, options: OpenDbOptions = {}): DatabaseSync {
  const db = new DatabaseSync(path)
  db.exec('pragma journal_mode = wal')
  db.exec('pragma busy_timeout = 5000')
  db.exec('pragma foreign_keys = on')

  const version = schemaVersionOf(db)
  if (version > SCHEMA_VERSION && !options.allowNewer) {
    db.close()
    throw new UserError(
      3,
      `схема ${version} новее, чем понимает инструмент (${SCHEMA_VERSION}): обновите инструмент`,
    )
  }
  if (version < SCHEMA_VERSION && !options.allowOutdated) migrate(db)

  return db
}

/**
 * Вложенные вызовы не открывают вторую транзакцию: внешний вызов остаётся
 * владельцем commit/rollback. Пишем сразу `begin immediate`, чтобы два
 * процесса не выдали один ID.
 */
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
