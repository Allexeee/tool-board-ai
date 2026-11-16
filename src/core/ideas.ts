import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { addRequest, type Request } from './requests.ts'
import { UserError } from '../cli/errors.ts'

export interface Idea {
  id: string
  text: string
  source: string
  reviewAt: string | null
  promotedTo: string | null
  createdAt: string
}

interface Row {
  id: string
  text: string
  source: string
  review_at: string | null
  promoted_to: string | null
  created_at: string
}

const toIdea = (row: Row): Idea => ({
  id: row.id,
  text: row.text,
  source: row.source,
  reviewAt: row.review_at,
  promotedTo: row.promoted_to,
  createdAt: row.created_at,
})

export function addIdea(
  db: DatabaseSync,
  input: { text: string; source?: string; reviewAt?: string },
): Idea {
  return tx(db, () => {
    const idea: Idea = {
      id: allocateId(db, 'idea'),
      text: input.text,
      source: input.source ?? 'owner',
      reviewAt: input.reviewAt ?? null,
      promotedTo: null,
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      'insert into ideas (id, text, source, review_at, promoted_to, created_at) values (?, ?, ?, ?, ?, ?)',
    ).run(idea.id, idea.text, idea.source, idea.reviewAt, null, idea.createdAt)

    appendEvent(db, { type: 'idea.added', actor: 'owner', subject: idea.id, after: { text: idea.text } })
    return idea
  })
}

export function listIdeas(db: DatabaseSync): Idea[] {
  return (db.prepare('select * from ideas order by created_at, id').all() as unknown as Row[]).map(toIdea)
}

export function getIdea(db: DatabaseSync, id: string): Idea | null {
  const row = db.prepare('select * from ideas where id = ?').get(id) as Row | undefined
  return row ? toIdea(row) : null
}

export function promoteIdea(
  db: DatabaseSync,
  input: { ideaId: string; author: string },
): { idea: Idea; request: Request } {
  return tx(db, () => {
    const idea = getIdea(db, input.ideaId)
    if (!idea) throw new UserError(3, `идея ${input.ideaId} не найдена`)
    if (idea.promotedTo) throw new UserError(1, `идея ${idea.id} уже стала запросом ${idea.promotedTo}`)

    const request = addRequest(db, { title: idea.text, body: idea.text, author: input.author })
    db.prepare('update ideas set promoted_to = ? where id = ?').run(request.id, idea.id)
    appendEvent(db, { type: 'idea.promoted', actor: input.author, subject: idea.id, after: { request: request.id } })

    return { idea: { ...idea, promotedTo: request.id }, request }
  })
}

export function staleIdeas(db: DatabaseSync, days = 30): Idea[] {
  const threshold = new Date(Date.now() - days * 86_400_000).toISOString()
  return listIdeas(db).filter(
    (idea) => !idea.promotedTo && (idea.reviewAt === null || idea.reviewAt < threshold),
  )
}
