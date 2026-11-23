import { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { migrate, schemaVersionOf, SCHEMA_VERSION } from './schema.ts'
import { backupBeforeMigration } from './backup.ts'

export { migrate } from './schema.ts'

const depth = new WeakMap<DatabaseSync, number>()

/** busy_timeout можно сократить в тестах: BOARD_BUSY_TIMEOUT_MS. */
function busyTimeoutMs(): number {
  return Number(process.env.BOARD_BUSY_TIMEOUT_MS ?? 5000)
}

function isBusy(error: unknown): boolean {
  const err = error as { code?: string; message?: string } | null
  return /SQLITE_BUSY|database is locked/i.test(`${err?.code ?? ''} ${err?.message ?? ''}`)
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** SQLITE_BUSY — не приговор: короткий backoff и повтор. */
export function retryOnBusy<T>(fn: () => T, attempts = 6): T {
  let delay = 20
  for (let attempt = 1; ; attempt++) {
    try {
      return fn()
    } catch (error) {
      if (!isBusy(error) || attempt >= attempts) throw error
      sleep(delay)
      delay = Math.min(delay * 2, 400)
    }
  }
}

function openConnection(path: string): DatabaseSync {
  return retryOnBusy(() => {
    const db = new DatabaseSync(path)
    try {
      // busy_timeout — до journal_mode: иначе переключение WAL падает сырым busy
      // при параллельных стартах агентов.
      db.exec(`pragma busy_timeout = ${busyTimeoutMs()}`)
      db.exec('pragma journal_mode = wal')
      db.exec('pragma foreign_keys = on')
      return db
    } catch (error) {
      db.close()
      throw error
    }
  })
}

export interface OpenDbOptions {
  /** Не мигрировать устаревшую схему: открыть как есть (нужно doctor). */
  allowOutdated?: boolean
  /** Не бросать на более новой схеме: открыть как есть (нужно doctor). */
  allowNewer?: boolean
}

export function openDb(path: string, options: OpenDbOptions = {}): DatabaseSync {
  let db: DatabaseSync
  try {
    db = openConnection(path)
  } catch (error) {
    if (isBusy(error)) {
      throw new UserError(
        2,
        `база ${path} занята другим процессом: подождите немного и повторите команду`,
      )
    }
    throw error
  }

  const version = schemaVersionOf(db)
  if (version > SCHEMA_VERSION && !options.allowNewer) {
    db.close()
    throw new UserError(
      3,
      `схема ${version} новее, чем понимает инструмент (${SCHEMA_VERSION}): обновите инструмент`,
    )
  }
  if (version < SCHEMA_VERSION && !options.allowOutdated) {
    // Перед изменением схемы — копия: миграция необратима.
    if (version > 0) backupBeforeMigration(db, path)
    migrate(db)
  }

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
