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

export function listIdeas(db: DatabaseSync, options: { all?: boolean } = {}): Idea[] {
  const ideas = (db.prepare('select * from ideas order by created_at, id').all() as unknown as Row[]).map(toIdea)
  if (options.all) return ideas

  return ideas.filter((idea) => !isRealized(db, idea))
}

/** Реализована — есть событие idea.realized или продвинутый запрос уже закрыт. */
export function isRealized(db: DatabaseSync, idea: Idea): boolean {
  const event = db
    .prepare("select 1 as found from events where type = 'idea.realized' and subject = ? limit 1")
    .get(idea.id)
  if (event) return true

  if (!idea.promotedTo) return false
  const request = db.prepare('select status from requests where id = ?').get(idea.promotedTo) as
    | { status: string }
    | undefined
  return request?.status === 'closed'
}

export function editIdea(
  db: DatabaseSync,
  input: { ideaId: string; text?: string; reviewAt?: string | null; actor: string },
): Idea {
  return tx(db, () => {
    const idea = getIdea(db, input.ideaId)
    if (!idea) throw new UserError(3, `идея ${input.ideaId} не найдена`)
    if (isRealized(db, idea)) throw new UserError(1, `идея ${idea.id} уже реализована: править нельзя`)

    const text = input.text?.trim() || idea.text
    const reviewAt = input.reviewAt === undefined ? idea.reviewAt : input.reviewAt

    db.prepare('update ideas set text = ?, review_at = ? where id = ?').run(text, reviewAt, idea.id)
    appendEvent(db, {
      type: 'idea.edited',
      actor: input.actor,
      subject: idea.id,
      before: { text: idea.text, reviewAt: idea.reviewAt },
      after: { text, reviewAt },
    })

    return getIdea(db, idea.id)!
  })
}

export function removeIdea(db: DatabaseSync, input: { ideaId: string; actor: string }): void {
  return tx(db, () => {
    const idea = getIdea(db, input.ideaId)
    if (!idea) throw new UserError(3, `идея ${input.ideaId} не найдена`)
    if (isRealized(db, idea)) {
      throw new UserError(1, `идея ${idea.id} реализована: удалять нельзя, связь с запросом важна`)
    }
    if (idea.promotedTo) {
      throw new UserError(1, `идея ${idea.id} стала запросом ${idea.promotedTo}: удалять нельзя`)
    }

    db.prepare('delete from ideas where id = ?').run(idea.id)
    appendEvent(db, {
      type: 'idea.removed',
      actor: input.actor,
      subject: idea.id,
      before: { text: idea.text },
    })
  })
}

export function realizeIdea(
  db: DatabaseSync,
  input: { ideaId: string; actor: string; note?: string },
): Idea {
  return tx(db, () => {
    const idea = getIdea(db, input.ideaId)
    if (!idea) throw new UserError(3, `идея ${input.ideaId} не найдена`)
    if (isRealized(db, idea)) throw new UserError(1, `идея ${idea.id} уже реализована`)

    appendEvent(db, {
      type: 'idea.realized',
      actor: input.actor,
      subject: idea.id,
      note: input.note,
      after: { request: idea.promotedTo },
    })

    return idea
  })
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
