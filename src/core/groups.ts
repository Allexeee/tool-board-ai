import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'

const PREFIX = /^[A-Z0-9]{1,8}$/

/** Префикс группы — 1–8 символов A-Z0-9; регистр не важен. */
export function normalizeGroupPrefix(raw: string): string {
  const prefix = raw.trim().toUpperCase()
  if (!PREFIX.test(prefix)) {
    throw new UserError(3, `недопустимый префикс группы «${raw}»: нужно 1–8 символов A-Z0-9`)
  }
  return prefix
}

export interface CardGroup {
  prefix: string
  name: string | null
  count: number
}

/** Области проекта: префикс, название и число карточек. */
export function listGroups(db: DatabaseSync): CardGroup[] {
  const rows = db
    .prepare(
      `select g.prefix, g.name,
              (select count(*) from cards c where c.group_prefix = g.prefix) as count
       from groups g order by g.prefix`,
    )
    .all() as Array<{ prefix: string; name: string | null; count: number }>
  return rows.map((row) => ({ prefix: row.prefix, name: row.name, count: row.count }))
}

export function groupExists(db: DatabaseSync, prefix: string): boolean {
  const row = db.prepare('select 1 as found from groups where prefix = ?').get(prefix)
  return row !== undefined
}
