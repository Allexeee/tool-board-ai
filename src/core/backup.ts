import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { UserError } from '../cli/errors.ts'

/** Сколько последних копий держим рядом с базой. */
const BACKUP_KEEP = 10

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
  if (!target?.trim()) pruneBackups(dbPath)
  return path
}

/** Ротация: рядом с базой остаются только последние BACKUP_KEEP копий. */
function pruneBackups(dbPath: string): void {
  const dir = dirname(dbPath)
  const prefix = `${basename(dbPath)}.bak-`
  try {
    const files = readdirSync(dir)
      .filter((name) => name.startsWith(prefix))
      .sort()
    for (const old of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      rmSync(join(dir, old), { force: true })
    }
  } catch {
    // ротация — уборка, а не часть бэкапа: не роняем команду
  }
}

/** Копия перед миграцией: только для файловой базы со старой схемой. */
export function backupBeforeMigration(db: DatabaseSync, dbPath: string): string | null {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return null
  return backupDatabase(db, dbPath)
}
