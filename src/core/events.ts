import type { DatabaseSync } from 'node:sqlite'

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

const json = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value)

export function appendEvent(db: DatabaseSync, event: EventInput): void {
  db.prepare(
    'insert into events (at, type, actor, subject, before, after, note) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    new Date().toISOString(),
    event.type,
    event.actor,
    event.subject,
    json(event.before),
    json(event.after),
    event.note ?? null,
  )
}

export function listEvents(
  db: DatabaseSync,
  filter: { subject?: string; since?: string } = {},
): EventRecord[] {
  const where: string[] = []
  const params: string[] = []

  if (filter.subject) {
    where.push('subject = ?')
    params.push(filter.subject)
  }
  if (filter.since) {
    where.push('at >= ?')
    params.push(filter.since)
  }

  const sql =
    'select id, at, type, actor, subject, before, after, note from events' +
    (where.length ? ' where ' + where.join(' and ') : '') +
    ' order by id'

  return db.prepare(sql).all(...params) as unknown as EventRecord[]
}
