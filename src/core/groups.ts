import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

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

/** Область проекта без карточки: префикс, название, событие в журнал. */
export function addGroup(
  db: DatabaseSync,
  input: { prefix: string; name?: string | null; actor: string },
): CardGroup {
  return tx(db, () => {
    const prefix = normalizeGroupPrefix(input.prefix)
    if (groupExists(db, prefix)) throw new UserError(3, `группа ${prefix} уже есть`)
    const name = input.name?.trim() ? input.name.trim() : null
    db.prepare('insert into groups (prefix, name, created_at) values (?, ?, ?)').run(
      prefix,
      name,
      nowIso(),
    )
    appendEvent(db, {
      type: 'group.added',
      actor: input.actor,
      subject: prefix,
      after: { prefix, name },
    })
    return { prefix, name, count: 0 }
  })
}
