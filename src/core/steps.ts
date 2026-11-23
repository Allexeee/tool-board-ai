import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getCard } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { RUN_LEASE_MS } from './runs.ts'
import type { Card } from './types.ts'

/** Чек-лист карточки: шаги не влияют на статус, их отмечает исполнитель. */
export interface Step {
  cardId: string
  seq: number
  text: string
  done: boolean
  doneAt: string | null
}

export interface AddStepInput {
  cardId: string
  text: string
  actor?: string
}

export interface DoneStepInput {
  cardId: string
  seq: number
  done?: boolean
  actor?: string
}

export interface RemoveStepInput {
  cardId: string
  seq: number
  actor?: string
}

/** У шагов нет своего автора в интерфейсе: без --as пишем владельца. */
const DEFAULT_ACTOR = 'owner'

interface Row {
  card_id: string
  seq: number
  text: string
  done: number
  done_at: string | null
}

const toStep = (row: Row): Step => ({
  cardId: row.card_id,
  seq: row.seq,
  text: row.text,
  done: row.done === 1,
  doneAt: row.done_at,
})

function requireCard(db: DatabaseSync, cardId: string): Card {
  const card = getCard(db, cardId)
  if (!card) throw new UserError(3, `карточка ${cardId} не найдена`)
  return card
}

function normalizeSeq(raw: number): number {
  if (!Number.isInteger(raw) || raw < 1) {
    throw new UserError(3, 'номер шага — целое число от 1')
  }
  return raw
}

function getStep(db: DatabaseSync, cardId: string, seq: number): Step | null {
  const row = db
    .prepare('select * from steps where card_id = ? and seq = ?')
    .get(cardId, seq) as Row | undefined
  return row ? toStep(row) : null
}

export function listSteps(db: DatabaseSync, cardId: string): Step[] {
  const rows = db
    .prepare('select * from steps where card_id = ? order by seq')
    .all(cardId) as unknown as Row[]
  return rows.map(toStep)
}

/** Новый шаг встаёт в конец: `max(seq) + 1`, дырки не переиспользуются. */
export function addStep(db: DatabaseSync, input: AddStepInput): Step {
  return tx(db, () => {
    const card = requireCard(db, input.cardId)
    const text = input.text.trim()
    if (!text) throw new UserError(3, 'нужен текст шага')

    const next = db
      .prepare('select coalesce(max(seq), 0) + 1 as seq from steps where card_id = ?')
      .get(input.cardId) as { seq: number }
    const seq = next.seq

    db.prepare('insert into steps (card_id, seq, text, done, done_at) values (?, ?, ?, 0, null)')
      .run(input.cardId, seq, text)

    // Шаг — признак живой работы: продлеваем lease, чтобы now/doctor не сняли карточку.
    if (card.status === 'booked' || card.status === 'in_progress') {
      const leaseUntil = new Date(Date.now() + RUN_LEASE_MS).toISOString()
      db.prepare('update cards set lease_until = ?, updated_at = ? where id = ?').run(
        leaseUntil,
        nowIso(),
        card.id,
      )
      if (card.runId) {
        db.prepare('update runs set lease_until = ? where id = ?').run(leaseUntil, card.runId)
      }
    }

    const step = getStep(db, input.cardId, seq)!
    appendEvent(db, {
      type: 'step.added',
      actor: input.actor ?? DEFAULT_ACTOR,
      subject: input.cardId,
      after: step,
    })
    return step
  })
}

export function doneStep(db: DatabaseSync, input: DoneStepInput): Step {
  const seq = normalizeSeq(input.seq)
  return tx(db, () => {
    const before = getStep(db, input.cardId, seq)
    if (!before) throw new UserError(3, `шаг ${seq} не найден у карточки ${input.cardId}`)

    const done = input.done ?? true
    const doneAt = done ? nowIso() : null
    db.prepare('update steps set done = ?, done_at = ? where card_id = ? and seq = ?')
      .run(done ? 1 : 0, doneAt, input.cardId, seq)

    const after = getStep(db, input.cardId, seq)!
    appendEvent(db, {
      type: 'step.updated',
      actor: input.actor ?? DEFAULT_ACTOR,
      subject: input.cardId,
      before,
      after,
    })
    return after
  })
}

export function removeStep(db: DatabaseSync, input: RemoveStepInput): Step {
  const seq = normalizeSeq(input.seq)
  return tx(db, () => {
    const step = getStep(db, input.cardId, seq)
    if (!step) throw new UserError(3, `шаг ${seq} не найден у карточки ${input.cardId}`)

    db.prepare('delete from steps where card_id = ? and seq = ?').run(input.cardId, seq)
    appendEvent(db, {
      type: 'step.removed',
      actor: input.actor ?? DEFAULT_ACTOR,
      subject: input.cardId,
      before: step,
    })
    return step
  })
}

export function stepProgress(db: DatabaseSync, cardId: string): { done: number; total: number } {
  const row = db
    .prepare(
      'select count(*) as total, coalesce(sum(done), 0) as done from steps where card_id = ?',
    )
    .get(cardId) as { total: number; done: number }
  return { done: row.done, total: row.total }
}
