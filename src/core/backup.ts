import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { UserError } from '../cli/errors.ts'

/** Метка времени для имени копии: компактная и сортируемая. */
function stamp(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('')
}

/**
 * Консистентная копия базы через `VACUUM INTO`: учитывает WAL и не требует
 * останавливать процессы. По умолчанию — рядом с базой, с меткой времени.
 */
export function backupDatabase(
  db: DatabaseSync,
  dbPath: string,
  target?: string,
): string {
  const path = target?.trim() || `${dbPath}.bak-${stamp()}`
  if (existsSync(path)) throw new UserError(3, `файл ${path} уже существует`)
  const escaped = path.replace(/'/g, "''")
  db.exec(`vacuum into '${escaped}'`)
  return path
}

/** Копия перед миграцией: только для файловой базы со старой схемой. */
export function backupBeforeMigration(db: DatabaseSync, dbPath: string): string | null {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return null
  return backupDatabase(db, dbPath)
}
