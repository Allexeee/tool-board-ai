import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './clock.ts'

export interface EventInput {
  type: string
  actor: string
  subject: string
  before?: unknown
  after?: unknown
  note?: string
}

export interface EventRecord {
  id: number
  at: string
  type: string
  actor: string
  subject: string
  before: string | null
  after: string | null
  note: string | null
}

export interface EventFilter {
  subject?: string
  since?: string
}

const json = (value: unknown): string | null => (value === undefined ? null : JSON.stringify(value))

export function appendEvent(db: DatabaseSync, event: EventInput): void {
  db.prepare(
    'insert into events (at, type, actor, subject, before, after, note) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    nowIso(),
    event.type,
    event.actor,
    event.subject,
    json(event.before),
    json(event.after),
    event.note ?? null,
  )
}

/** `listEvents(db, 'UI-1')` — журнал карточки, объект — фильтр; без аргумента — весь журнал. */
export function listEvents(
  db: DatabaseSync,
  filter: string | EventFilter = {},
): EventRecord[] {
  const options: EventFilter = typeof filter === 'string' ? { subject: filter } : filter
  const where: string[] = []
  const params: string[] = []

  if (options.subject) {
    where.push('subject = ?')
    params.push(options.subject)
  }
  if (options.since) {
    where.push('at >= ?')
    params.push(options.since)
  }

  const sql =
    'select id, at, type, actor, subject, before, after, note from events' +
    (where.length > 0 ? ' where ' + where.join(' and ') : '') +
    ' order by id'

  return db.prepare(sql).all(...params) as unknown as EventRecord[]
}
