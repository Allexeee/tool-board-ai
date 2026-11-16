import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { UserError } from '../cli/errors.ts'

export type RequestStatus = 'inbox' | 'shaping' | 'planned' | 'later' | 'closed'

export interface Request {
  id: string
  title: string
  body: string
  status: RequestStatus
  author: string
  createdAt: string
  reviewAt: string | null
}

interface Row {
  id: string
  title: string
  body: string
  status: RequestStatus
  author: string
  created_at: string
  review_at: string | null
}

const toRequest = (row: Row): Request => ({
  id: row.id,
  title: row.title,
  body: row.body,
  status: row.status,
  author: row.author,
  createdAt: row.created_at,
  reviewAt: row.review_at,
})

export function addRequest(
  db: DatabaseSync,
  input: { title: string; body: string; author: string },
): Request {
  const request: Request = {
    id: allocateId(db, 'request'),
    title: input.title,
    body: input.body,
    status: 'inbox',
    author: input.author,
    createdAt: new Date().toISOString(),
    reviewAt: null,
  }

  db.prepare(
    'insert into requests (id, title, body, status, author, created_at, review_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    request.id,
    request.title,
    request.body,
    request.status,
    request.author,
    request.createdAt,
    null,
  )

  return request
}

export function getRequest(db: DatabaseSync, id: string): Request | null {
  const row = db.prepare('select * from requests where id = ?').get(id) as Row | undefined
  return row ? toRequest(row) : null
}

export function listRequests(db: DatabaseSync): Request[] {
  return (db.prepare('select * from requests order by created_at, id').all() as unknown as Row[]).map(toRequest)
}

export function editRequest(
  db: DatabaseSync,
  input: { id: string; title?: string; body?: string; actor: string },
): Request {
  return tx(db, () => {
    const request = getRequest(db, input.id)
    if (!request) throw new UserError(3, `запрос ${input.id} не найден`)

    const next: Request = {
      ...request,
      title: input.title?.trim() || request.title,
      body: input.body ?? request.body,
    }

    db.prepare('update requests set title = ?, body = ? where id = ?').run(next.title, next.body, request.id)
    appendEvent(db, {
      type: 'request.edited',
      actor: input.actor,
      subject: request.id,
      before: { title: request.title, body: request.body },
      after: { title: next.title, body: next.body },
    })

    return next
  })
}

export function mergeRequests(
  db: DatabaseSync,
  input: { from: string; to: string; actor: string },
): Request {
  return tx(db, () => {
    const source = getRequest(db, input.from)
    const target = getRequest(db, input.to)

    if (!source) throw new UserError(3, `запрос ${input.from} не найден`)
    if (!target) throw new UserError(3, `запрос ${input.to} не найден`)
    if (source.id === target.id) throw new UserError(3, 'нельзя объединить запрос с собой')
    if (target.status === 'closed') throw new UserError(1, `запрос ${target.id} уже закрыт`)

    const body = `${target.body}\n\n---\nИз ${source.id}: ${source.body}`
    db.prepare('update requests set body = ? where id = ?').run(body, target.id)
    db.prepare("update requests set status = 'closed' where id = ?").run(source.id)

    appendEvent(db, {
      type: 'request.merged',
      actor: input.actor,
      subject: source.id,
      after: { into: target.id },
    })
    appendEvent(db, {
      type: 'request.merged_into',
      actor: input.actor,
      subject: target.id,
      after: { from: source.id },
    })

    return getRequest(db, target.id)!
  })
}
