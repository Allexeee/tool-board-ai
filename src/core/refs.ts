import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getCard } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

export type RefKind = 'link' | 'doc' | 'spec'

/** Ссылка или документ карточки: всё остальное живёт в body. */
export interface Ref {
  id: number
  cardId: string
  kind: RefKind
  value: string
  title: string | null
  createdAt: string
}

export interface AddRefInput {
  cardId: string
  kind: RefKind
  value: string
  title?: string
  actor?: string
}

export interface RemoveRefInput {
  cardId: string
  id: number
  actor?: string
}

const KINDS: readonly RefKind[] = ['link', 'doc', 'spec']
const DEFAULT_ACTOR = 'owner'

interface Row {
  id: number
  card_id: string
  kind: string
  value: string
  title: string | null
  created_at: string
}

const toRef = (row: Row): Ref => ({
  id: row.id,
  cardId: row.card_id,
  kind: row.kind as RefKind,
  value: row.value,
  title: row.title,
  createdAt: row.created_at,
})

function requireCard(db: DatabaseSync, cardId: string): void {
  if (!getCard(db, cardId)) throw new UserError(3, `карточка ${cardId} не найдена`)
}

function normalizeKind(raw: string): RefKind {
  if (!KINDS.includes(raw as RefKind)) {
    throw new UserError(3, `kind ссылки — ${KINDS.join(', ')}, а не «${raw}»`)
  }
  return raw as RefKind
}

export function addRef(db: DatabaseSync, input: AddRefInput): Ref {
  return tx(db, () => {
    requireCard(db, input.cardId)
    const kind = normalizeKind(input.kind)
    const value = input.value.trim()
    if (!value) throw new UserError(3, 'нужно значение ссылки')
    const title = input.title?.trim() || null

    const result = db
      .prepare('insert into refs (card_id, kind, value, title, created_at) values (?, ?, ?, ?, ?)')
      .run(input.cardId, kind, value, title, nowIso())

    const ref = db
      .prepare('select * from refs where id = ?')
      .get(Number(result.lastInsertRowid)) as Row
    appendEvent(db, {
      type: 'ref.added',
      actor: input.actor ?? DEFAULT_ACTOR,
      subject: input.cardId,
      after: toRef(ref),
    })
    return toRef(ref)
  })
}

export function listRefs(db: DatabaseSync, cardId: string): Ref[] {
  const rows = db
    .prepare('select * from refs where card_id = ? order by id')
    .all(cardId) as unknown as Row[]
  return rows.map(toRef)
}

export function removeRef(db: DatabaseSync, input: RemoveRefInput): Ref {
  return tx(db, () => {
    const row = db
      .prepare('select * from refs where id = ? and card_id = ?')
      .get(input.id, input.cardId) as Row | undefined
    if (!row) throw new UserError(3, `ссылка ${input.id} не найдена у карточки ${input.cardId}`)

    db.prepare('delete from refs where id = ?').run(input.id)
    appendEvent(db, {
      type: 'ref.removed',
      actor: input.actor ?? DEFAULT_ACTOR,
      subject: input.cardId,
      before: toRef(row),
    })
    return toRef(row)
  })
}
