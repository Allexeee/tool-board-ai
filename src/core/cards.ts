import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { allocateGroupId } from './ids.ts'
import { normalizeGroupPrefix } from './groups.ts'
import type { Card, CardPhase, CardStatus } from './types.ts'

export interface NewCardInput {
  group: string
  title: string
  body?: string
  acceptance?: string[]
  skill: string
  author: string
  tags?: string[]
  /** false — карточка без git-мержа (доска без git или контент). */
  needsMerge?: boolean
}

export interface CardFilter {
  phase?: CardPhase | CardPhase[]
  status?: CardStatus | CardStatus[]
  skill?: string
  holder?: string
  group?: string
  tag?: string
}

export interface CardPatch {
  title?: string
  body?: string
  acceptance?: string[]
  skill?: string
  importance?: number | null
  urgency?: number | null
  needsMerge?: boolean
  reviewRequired?: boolean
  scope?: string[]
  tags?: string[]
  note?: string | null
}

const PHASES: readonly CardPhase[] = ['request', 'task']
const STATUSES: readonly CardStatus[] = [
  'new',
  'shaping',
  'approval',
  'waiting',
  'ready',
  'booked',
  'in_progress',
  'blocked',
  'deferred',
  'review',
  'done',
  'cancelled',
]

/** Навык owner означает owner-карточку: сразу задача, без мержа и ревью. */
const OWNER_SKILL = 'owner'

/** Навык меняется только до submit: дальше карточку отменяют и создают новую. */
const SKILL_EDITABLE: readonly CardStatus[] = ['new', 'shaping']

const SCORE_MIN = 0
const SCORE_MAX = 3

interface Row {
  id: string
  group_prefix: string
  group_seq: number
  title: string
  body: string
  acceptance: string
  phase: string
  status: string
  skill: string | null
  importance: number | null
  urgency: number | null
  position: number | null
  needs_merge: number
  review_required: number
  scope: string
  tags: string
  severity: string | null
  origin_card_id: string | null
  summary: string | null
  holder: string | null
  run_id: string | null
  branch: string | null
  attempt: number
  spec_rev: number
  review_reopens: number
  merge_commit: string | null
  in_dev: number
  in_main: number
  reverted_at: string | null
  revert_commit: string | null
  waive_deps: number
  lease_until: string | null
  previous_holder: string | null
  created_at: string
  updated_at: string
  shaped_at: string | null
  approved_at: string | null
  done_at: string | null
  cancel_reason: string | null
  note: string | null
}

const toCard = (row: Row): Card => ({
  id: row.id,
  group: row.group_prefix,
  groupSeq: row.group_seq,
  title: row.title,
  body: row.body,
  acceptance: row.acceptance,
  phase: row.phase as CardPhase,
  status: row.status as CardStatus,
  skill: row.skill,
  importance: row.importance,
  urgency: row.urgency,
  position: row.position,
  needsMerge: row.needs_merge === 1,
  reviewRequired: row.review_required === 1,
  scope: JSON.parse(row.scope) as string[],
  tags: JSON.parse(row.tags) as string[],
  severity: row.severity as Card['severity'],
  originCardId: row.origin_card_id,
  summary: row.summary,
  holder: row.holder,
  runId: row.run_id,
  branch: row.branch,
  attempt: row.attempt,
  specRev: row.spec_rev,
  reviewReopens: row.review_reopens,
  mergeCommit: row.merge_commit,
  inDev: row.in_dev === 1,
  inMain: row.in_main === 1,
  revertedAt: row.reverted_at,
  revertCommit: row.revert_commit,
  waiveDeps: row.waive_deps === 1,
  leaseUntil: row.lease_until,
  previousHolder: row.previous_holder,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  shapedAt: row.shaped_at,
  approvedAt: row.approved_at,
  doneAt: row.done_at,
  cancelReason: row.cancel_reason,
  note: row.note,
})

function requiredText(raw: string, message: string): string {
  const value = raw.trim()
  if (!value) throw new UserError(3, message)
  return value
}

function normalizeScore(raw: number, label: string): number {
  if (!Number.isInteger(raw) || raw < SCORE_MIN || raw > SCORE_MAX) {
    throw new UserError(3, `${label} — целое число от ${SCORE_MIN} до ${SCORE_MAX}`)
  }
  return raw
}

function normalizeScope(raw: string[]): string[] {
  return raw.map((value) => value.trim()).filter(Boolean)
}

/** Теги — свободные метки: нижний регистр, без дублей и пустых. */
export function normalizeTags(raw: string[]): string[] {
  return [...new Set(raw.map((value) => value.trim().toLowerCase()).filter(Boolean))]
}

function normalizeAcceptance(raw: string[]): string {
  return raw
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n')
}

function filterValues<T extends string>(value: T | T[], allowed: readonly T[], label: string): T[] {
  const values = Array.isArray(value) ? value : [value]
  for (const item of values) {
    if (!allowed.includes(item)) {
      throw new UserError(3, `${label} «${item}» неизвестен: допустимо ${allowed.join(', ')}`)
    }
  }
  return [...new Set(values)]
}

interface CardInsert {
  id: string
  group: string
  groupSeq: number
  title: string
  body: string
  acceptance: string
  phase: CardPhase
  status: CardStatus
  skill: string
  needsMerge: boolean
  tags: string
  createdAt: string
}

function insertCard(db: DatabaseSync, card: CardInsert): void {
  db.prepare(
    `insert into cards (
       id, group_prefix, group_seq, title, body, acceptance, phase, status, skill,
       importance, urgency, position, needs_merge, review_required, scope, tags,
       severity, origin_card_id, summary, holder, run_id, branch, attempt,
       spec_rev, review_reopens, merge_commit, in_dev, in_main, reverted_at,
       revert_commit, waive_deps, lease_until, previous_holder, created_at,
       updated_at, shaped_at, approved_at, done_at, cancel_reason, note
     ) values (
       ?, ?, ?, ?, ?, ?, ?, ?, ?,
       null, null, null, ?, 0, '[]', ?,
       null, null, null, null, null, null, 1,
       1, 0, null, 0, 0, null,
       null, 0, null, null, ?, ?,
       null, null, null, null, null
     )`,
  ).run(
    card.id,
    card.group,
    card.groupSeq,
    card.title,
    card.body,
    card.acceptance,
    card.phase,
    card.status,
    card.skill,
    card.needsMerge ? 1 : 0,
    card.tags,
    card.createdAt,
    card.createdAt,
  )
}

/**
 * Карточка создаётся и получает ID одной транзакцией: счётчик группы и строка
 * не расходятся, даже если процесс упадёт между шагами.
 */
export function createCard(db: DatabaseSync, input: NewCardInput): Card {
  return tx(db, () => {
    const title = requiredText(input.title, 'нужен заголовок карточки')
    const skill = requiredText(input.skill, 'нужен навык карточки')
    const author = requiredText(input.author, 'нужен автор карточки')
    const group = normalizeGroupPrefix(input.group)

    const id = allocateGroupId(db, group)
    const dashed = id.lastIndexOf('-')
    const createdAt = nowIso()
    const isOwner = skill === OWNER_SKILL

    insertCard(db, {
      id,
      group: id.slice(0, dashed),
      groupSeq: Number(id.slice(dashed + 1)),
      title,
      body: input.body ?? '',
      acceptance: normalizeAcceptance(input.acceptance ?? []),
      phase: isOwner ? 'task' : 'request',
      status: isOwner ? 'ready' : 'new',
      skill,
      needsMerge: input.needsMerge ?? !isOwner,
      tags: JSON.stringify(normalizeTags(input.tags ?? [])),
      createdAt,
    })

    const card = getCard(db, id)!
    appendEvent(db, {
      type: 'card.created',
      actor: author,
      subject: id,
      after: card,
    })
    return card
  })
}

export function getCard(db: DatabaseSync, id: string): Card | null {
  const row = db.prepare('select * from cards where id = ?').get(id) as Row | undefined
  return row ? toCard(row) : null
}

export function listCards(db: DatabaseSync, filter: CardFilter = {}): Card[] {
  const where: string[] = []
  const params: string[] = []

  if (filter.phase !== undefined) {
    const phases = filterValues(filter.phase, PHASES, 'фаза')
    where.push(`phase in (${phases.map(() => '?').join(', ')})`)
    params.push(...phases)
  }
  if (filter.status !== undefined) {
    const statuses = filterValues(filter.status, STATUSES, 'статус')
    where.push(`status in (${statuses.map(() => '?').join(', ')})`)
    params.push(...statuses)
  }
  if (filter.skill !== undefined) {
    where.push('skill = ?')
    params.push(filter.skill)
  }
  if (filter.holder !== undefined) {
    where.push('holder = ?')
    params.push(filter.holder)
  }
  if (filter.group !== undefined) {
    where.push('group_prefix = ?')
    params.push(normalizeGroupPrefix(filter.group))
  }
  if (filter.tag !== undefined) {
    where.push('exists (select 1 from json_each(cards.tags) where json_each.value = ?)')
    params.push(filter.tag)
  }

  const sql =
    'select * from cards' +
    (where.length > 0 ? ' where ' + where.join(' and ') : '') +
    ' order by created_at, rowid'

  return (db.prepare(sql).all(...params) as unknown as Row[]).map(toCard)
}

/**
 * Правка разрешена в любой фазе, кроме навыка: после submit навык неизменяем,
 * чтобы owner-карточка не превратилась в задачу для агента незаметно.
 */
export function editCard(
  db: DatabaseSync,
  input: { id: string; actor: string; patch: CardPatch },
): Card {
  return tx(db, () => {
    const card = getCard(db, input.id)
    if (!card) throw new UserError(3, `карточка ${input.id} не найдена`)

    const actor = requiredText(input.actor, 'нужен автор изменения')
    const patch = input.patch
    if (
      patch.reviewRequired !== undefined &&
      card.status !== 'new' &&
      card.status !== 'shaping' &&
      actor !== OWNER_SKILL
    ) {
      throw new UserError(
        3,
        `менять review_required карточки ${card.id} после approve может только владелец`,
      )
    }
    const touchesSpec =
      patch.body !== undefined ||
      patch.acceptance !== undefined ||
      patch.scope !== undefined
    if (touchesSpec && card.status !== 'new' && card.status !== 'shaping') {
      throw new UserError(
        3,
        `spec карточки ${card.id} утверждён: используйте board card amend`,
      )
    }
    const sets: string[] = []
    const params: (string | number | null)[] = []
    let specChanged = false

    if (patch.title !== undefined) {
      sets.push('title = ?')
      params.push(requiredText(patch.title, 'нужен заголовок карточки'))
    }
    if (patch.body !== undefined && patch.body !== card.body) {
      sets.push('body = ?')
      params.push(patch.body)
      specChanged = true
    }
    if (patch.acceptance !== undefined) {
      const acceptance = normalizeAcceptance(patch.acceptance)
      if (acceptance !== card.acceptance) {
        sets.push('acceptance = ?')
        params.push(acceptance)
        specChanged = true
      }
    }
    if (patch.skill !== undefined) {
      const skill = requiredText(patch.skill, 'нужен навык карточки')
      if (skill !== card.skill) {
        if (!SKILL_EDITABLE.includes(card.status)) {
          throw new UserError(
            3,
            `навык карточки ${card.id} неизменяем после submit: отмените карточку и создайте новую`,
          )
        }
        if (skill === OWNER_SKILL && (patch.needsMerge ?? card.needsMerge)) {
          throw new UserError(
            3,
            'owner-карточке не нужен мерж: укажите --no-needs-merge вместе с навыком owner',
          )
        }
        sets.push('skill = ?')
        params.push(skill)
        // Owner-карточки не стоят ни в одной очереди: позиция сбрасывается.
        if (skill === OWNER_SKILL) {
          // Owner-карточка — сразу задача владельца: без мержа, ревью и очереди.
          sets.push('phase = ?')
          params.push('task')
          sets.push('status = ?')
          params.push('ready')
          sets.push('review_required = 0')
          sets.push('position = null')
          // Держатель, lease и забег снимаются: задачу владельца никто не держит.
          sets.push('holder = null')
          sets.push('lease_until = null')
          sets.push('run_id = null')
          if (card.runId) {
            db.prepare(
              "update run_cards set status = 'dropped' where run_id = ? and card_id = ?",
            ).run(card.runId, card.id)
          }
        }
      }
    }
    if (patch.importance !== undefined) {
      sets.push('importance = ?')
      params.push(patch.importance === null ? null : normalizeScore(patch.importance, 'важность'))
    }
    if (patch.urgency !== undefined) {
      sets.push('urgency = ?')
      params.push(patch.urgency === null ? null : normalizeScore(patch.urgency, 'срочность'))
    }
    if (patch.needsMerge !== undefined) {
      if (card.skill === OWNER_SKILL && patch.needsMerge) {
        throw new UserError(3, 'owner-карточка не мержится: needs_merge должен быть false')
      }
      sets.push('needs_merge = ?')
      params.push(patch.needsMerge ? 1 : 0)
    }
    if (patch.reviewRequired !== undefined) {
      const effectiveSkill = patch.skill !== undefined ? patch.skill.trim() : card.skill
      if (patch.reviewRequired && effectiveSkill === OWNER_SKILL) {
        throw new UserError(3, 'owner-карточка не ревьюится: review_required должен быть false')
      }
      sets.push('review_required = ?')
      params.push(patch.reviewRequired ? 1 : 0)
    }
    if (patch.scope !== undefined) {
      const scope = normalizeScope(patch.scope)
      if (JSON.stringify(scope) !== JSON.stringify(card.scope)) {
        sets.push('scope = ?')
        params.push(JSON.stringify(scope))
        specChanged = true
      }
    }
    if (patch.tags !== undefined) {
      const tags = normalizeTags(patch.tags)
      if (JSON.stringify(tags) !== JSON.stringify(card.tags)) {
        sets.push('tags = ?')
        params.push(JSON.stringify(tags))
      }
    }
    if (patch.note !== undefined) {
      sets.push('note = ?')
      params.push(patch.note === null ? null : patch.note)
    }

    if (sets.length === 0) return card

    if (specChanged) sets.push('spec_rev = spec_rev + 1')
    sets.push('updated_at = ?')
    params.push(nowIso())
    params.push(card.id)

    db.prepare(`update cards set ${sets.join(', ')} where id = ?`).run(...params)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.edited',
      actor,
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}
