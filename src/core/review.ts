import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { createCard, getCard, listCards } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { addDep, refreshReadiness } from './deps.ts'
import { appendEvent } from './events.ts'
import { insertIntoQueue, moveCard } from './queue.ts'
import type { Card, Severity } from './types.ts'

/** Находка ревью §9.6: severity + текст; skill/scope перекрывают наследуемое. */
export interface FindingInput {
  severity: Severity
  text: string
  skill?: string
  scope?: string[]
}

export interface AddFindingInput {
  cardId: string
  reviewer: string
  severity: Severity
  text: string
  skill?: string
  scope?: string[]
}

export interface SubmitVerdictInput {
  cardId: string
  reviewer: string
  verdict: 'done' | 'reopen'
  note?: string
  findings?: FindingInput[]
  planCompliance?: 'done' | 'failed'
  mode?: 'self' | 'subagent'
}

const SEVERITIES: readonly Severity[] = ['critical', 'important', 'other']
const OWNER = 'owner'

function requireCard(db: DatabaseSync, id: string): Card {
  const card = getCard(db, id)
  if (!card) throw new UserError(3, `карточка ${id} не найдена`)
  return card
}

function requiredText(raw: string, message: string): string {
  const value = raw.trim()
  if (!value) throw new UserError(3, message)
  return value
}

function normalizeSeverity(raw: Severity): Severity {
  if (!SEVERITIES.includes(raw)) {
    throw new UserError(3, `severity — ${SEVERITIES.join(', ')}, а не «${raw}»`)
  }
  return raw
}

/** Карточки на ревью в порядке очереди: по позиции, затем по времени создания. */
export function listReviewCards(db: DatabaseSync): Card[] {
  return listCards(db, { status: 'review' }).sort(
    (left, right) =>
      (left.position ?? Number.MAX_SAFE_INTEGER) -
        (right.position ?? Number.MAX_SAFE_INTEGER) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  )
}

/**
 * Находка — отдельная карточка-запрос в группе проверяемой карточки. Наследует
 * `skill`, `needs_merge` и `scope`; `skill`/`scope` можно перекрыть. `body` — текст.
 */
export function addFinding(db: DatabaseSync, input: AddFindingInput): Card {
  return tx(db, () => {
    const origin = requireCard(db, input.cardId)
    const reviewer = requiredText(input.reviewer, 'нужен ревьюер')
    const severity = normalizeSeverity(input.severity)
    const text = requiredText(input.text, 'нужен текст находки')

    const finding = createCard(db, {
      group: origin.group,
      title: `Находка ревью ${origin.id}`,
      body: text,
      skill: input.skill ?? origin.skill ?? 'dev',
      author: reviewer,
      tags: ['review'],
    })

    db.prepare(
      `update cards set phase = 'request', status = 'new', severity = ?, origin_card_id = ?,
       needs_merge = ?, scope = ?, updated_at = ? where id = ?`,
    ).run(
      severity,
      origin.id,
      origin.needsMerge ? 1 : 0,
      JSON.stringify(input.scope ?? origin.scope),
      nowIso(),
      finding.id,
    )

    const updated = getCard(db, finding.id)!
    appendEvent(db, {
      type: 'review.finding',
      actor: reviewer,
      subject: finding.id,
      after: updated,
      note: `из ревью ${origin.id}`,
    })
    return updated
  })
}

/**
 * Вердикт ревью §9.3/§9.6 — одна транзакция: находки, строка `reviews` и переход
 * проверяемой карточки. `done` ставит `done`; `reopen` ставит `ready`, запоминает
 * `previous_holder`, возвращает в начало очереди и вешает зависимости на критические
 * находки. `refreshReadiness` пересчитывает `ready`/`waiting` самой карточки и её
 * зависимых; `revalidateDependents` снимает забронированных зависимых с забега.
 */
export function submitVerdict(
  db: DatabaseSync,
  input: SubmitVerdictInput,
): { card: Card; findings: Card[] } {
  return tx(db, () => {
    const card = requireCard(db, input.cardId)
    const reviewer = requiredText(input.reviewer, 'нужен ревьюер')
    const verdict = input.verdict
    if (verdict !== 'done' && verdict !== 'reopen') {
      throw new UserError(3, `verdict — done или reopen, а не «${verdict}»`)
    }
    if (card.status !== 'review') {
      throw new UserError(3, `карточка ${card.id} не на ревью: ${card.status}`)
    }

    const note = input.note?.trim() || null
    if (verdict === 'reopen' && !note) {
      throw new UserError(3, 'переоткрытие требует причину: --note «...»')
    }
    const planCompliance = input.planCompliance ?? 'done'
    if (planCompliance === 'failed' && verdict !== 'reopen') {
      throw new UserError(3, 'plan failed требует verdict reopen')
    }
    if (verdict === 'reopen' && card.reviewReopens >= 1 && reviewer !== OWNER) {
      throw new UserError(2, `карточка ${card.id}: один reopen уже был, нужно решение владельца`)
    }

    const findings = (input.findings ?? []).map((item) =>
      addFinding(db, {
        cardId: card.id,
        reviewer,
        severity: item.severity,
        text: item.text,
        skill: item.skill,
        scope: item.scope,
      }),
    )

    db.prepare(
      `insert into reviews (card_id, reviewer, verdict, note, at, kind, mode, spec_rev, plan_compliance)
       values (?, ?, ?, ?, ?, 'run', ?, ?, ?)`,
    ).run(
      card.id,
      reviewer,
      verdict,
      note,
      nowIso(),
      input.mode ?? null,
      card.specRev,
      planCompliance,
    )

    const at = nowIso()
    if (verdict === 'done') {
      db.prepare('update cards set status = ?, done_at = ?, updated_at = ? where id = ?').run(
        'done',
        at,
        at,
        card.id,
      )
      if (card.runId) {
        db.prepare("update run_cards set status = 'reviewed' where run_id = ? and card_id = ?").run(
          card.runId,
          card.id,
        )
      }
    } else {
      db.prepare(
        `update cards set status = 'ready', previous_holder = ?, holder = null, run_id = null,
         lease_until = null, attempt = attempt + 1, review_reopens = review_reopens + 1,
         updated_at = ? where id = ?`,
      ).run(card.holder, at, card.id)

      // Переоткрытая карточка возвращается в начало очереди задач.
      if (card.skill !== OWNER) {
        if (getCard(db, card.id)!.position === null) insertIntoQueue(db, card.id)
        moveCard(db, card.id, { top: true })
      }

      for (const finding of findings) {
        if (finding.severity === 'critical') {
          addDep(db, card.id, finding.id, reviewer, 'критическая находка ревью')
        }
      }
    }

    refreshReadiness(db)
    if (verdict === 'reopen') revalidateDependents(db, card.id)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: `review.${verdict}`,
      actor: reviewer,
      subject: card.id,
      before: card,
      after: updated,
      note: note ?? undefined,
    })
    return { card: updated, findings }
  })
}

/**
 * Переоткрытие зависимости §3.4/§9.3: зависимые возвращаются в `waiting`.
 * Не начатые (`ready`) — в `waiting`; забронированные — в `waiting` и сняты с
 * забега (`run_cards` → `dropped`); в работе остаются, их `finish` откажет из-за
 * незакрытой зависимости. Возвращает число изменённых карточек.
 */
export function revalidateDependents(db: DatabaseSync, cardId: string): number {
  return tx(db, () => {
    const rows = db
      .prepare('select from_id from deps where to_id = ? order by from_id')
      .all(cardId) as Array<{ from_id: string }>

    let changed = 0
    for (const row of rows) {
      const dependent = getCard(db, row.from_id)
      if (!dependent) continue

      if (dependent.status === 'booked') {
        const before = dependent
        db.prepare(
          `update cards set status = 'waiting', holder = null, run_id = null, lease_until = null,
           updated_at = ? where id = ?`,
        ).run(nowIso(), dependent.id)
        if (dependent.runId) {
          db.prepare('update run_cards set status = ? where run_id = ? and card_id = ?').run(
            'dropped',
            dependent.runId,
            dependent.id,
          )
        }
        appendEvent(db, {
          type: 'card.revalidated',
          actor: 'system',
          subject: dependent.id,
          before,
          after: getCard(db, dependent.id),
          note: `зависимость ${cardId} переоткрыта`,
        })
        changed++
      } else if (dependent.status === 'ready') {
        const before = dependent
        db.prepare('update cards set status = ?, updated_at = ? where id = ?').run(
          'waiting',
          nowIso(),
          dependent.id,
        )
        appendEvent(db, {
          type: 'card.revalidated',
          actor: 'system',
          subject: dependent.id,
          before,
          after: getCard(db, dependent.id),
          note: `зависимость ${cardId} переоткрыта`,
        })
        changed++
      }
    }
    return changed
  })
}
