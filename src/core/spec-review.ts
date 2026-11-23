import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getCard } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import type { Card, Review } from './types.ts'

export interface SpecReviewInput {
  cardId: string
  reviewer: string
  mode: 'self' | 'subagent'
  verdict: 'done' | 'reopen'
  note?: string
}

export interface SpecReviewGate {
  mode: 'none' | 'self' | 'subagent'
  reviewerModel: string | null
}

interface ReviewRow {
  id: number
  card_id: string
  reviewer: string
  verdict: string
  note: string | null
  at: string
  kind: string
  mode: string | null
  spec_rev: number | null
  plan_compliance: string | null
}

function toReview(row: ReviewRow): Review {
  return {
    id: row.id,
    cardId: row.card_id,
    reviewer: row.reviewer,
    verdict: row.verdict as Review['verdict'],
    note: row.note,
    at: row.at,
    kind: row.kind as Review['kind'],
    mode: row.mode as Review['mode'],
    specRev: row.spec_rev,
    planCompliance: row.plan_compliance as Review['planCompliance'],
  }
}

function required(raw: string | undefined, message: string): string {
  const value = raw?.trim()
  if (!value) throw new UserError(3, message)
  return value
}

/** Запись spec review; не меняет статус карточки. */
export function recordSpecReview(db: DatabaseSync, input: SpecReviewInput): Review {
  return tx(db, () => {
    const card = getCard(db, input.cardId)
    if (!card) throw new UserError(3, `карточка ${input.cardId} не найдена`)
    if (card.status !== 'shaping') {
      throw new UserError(3, `карточка ${card.id} не в shaping: spec review до submit`)
    }
    if (card.body.trim() === '') {
      throw new UserError(3, `у карточки ${card.id} нет spec`)
    }
    if (card.acceptance.trim() === '') {
      throw new UserError(3, `у карточки ${card.id} нет критериев приёмки`)
    }

    const reviewer = required(input.reviewer, 'нужен ревьюер spec')
    const note = input.note?.trim() || null
    const at = nowIso()
    const result = db
      .prepare(
        `insert into reviews (card_id, reviewer, verdict, note, at, kind, mode, spec_rev, plan_compliance)
         values (?, ?, ?, ?, ?, 'spec', ?, ?, null)`,
      )
      .run(card.id, reviewer, input.verdict, note, at, input.mode, card.specRev)
    const id = Number(result.lastInsertRowid)
    const row = db.prepare('select * from reviews where id = ?').get(id) as unknown as ReviewRow
    const review = toReview(row)

    appendEvent(db, {
      type: 'spec.reviewed',
      actor: reviewer,
      subject: card.id,
      after: review,
      note: input.verdict,
    })
    return review
  })
}

export function latestSpecReview(db: DatabaseSync, cardId: string): Review | null {
  const row = db
    .prepare(
      "select * from reviews where card_id = ? and kind = 'spec' order by id desc limit 1",
    )
    .get(cardId) as unknown as ReviewRow | undefined
  return row ? toReview(row) : null
}

/** Проверяет, что для текущей версии spec есть подходящий done-review. */
export function assertSpecReview(
  db: DatabaseSync,
  card: Card,
  gate: SpecReviewGate,
): void {
  if (gate.mode === 'none') return
  if (gate.mode === 'subagent' && gate.reviewerModel === null) {
    throw new UserError(
      2,
      'spec review требует субагента, но reviewer.model не задан: board setup --reviewer-model или выберите self',
    )
  }

  const latest = latestSpecReview(db, card.id)
  if (!latest || latest.verdict !== 'done' || latest.specRev !== card.specRev) {
    throw new UserError(
      2,
      `spec review для ${card.id} не пройден или устарел: выполните board card spec-review`,
    )
  }
  if (gate.mode === 'subagent' && latest.mode !== 'subagent') {
    throw new UserError(
      2,
      `spec review для ${card.id} требует субагента, а записан self`,
    )
  }
}
