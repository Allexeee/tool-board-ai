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
  acceptance?: boolean
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
  ownerAcceptance?: boolean
  ownerAcceptanceManual?: boolean
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
  'acceptance',
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
  plan_waived: number
  scope: string
  tags: string
  legacy_ids: string
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
  main_commit: string | null
  owner_acceptance: number
  owner_acceptance_manual: number
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
  legacyIds: JSON.parse(row.legacy_ids) as string[],
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
  planWaived: row.plan_waived === 1,
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
  mainCommit: row.main_commit,
  ownerAcceptance: row.owner_acceptance === 1,
  ownerAcceptanceManual: row.owner_acceptance_manual === 1,
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

/** Текущий ID по старому: ищет в legacy_ids после rekey. */
export function resolveCardId(db: DatabaseSync, id: string): string | null {
  if (getCard(db, id)) return id
  const row = db
    .prepare(
      `select id from cards
       where exists (select 1 from json_each(cards.legacy_ids) where json_each.value = ?)
       limit 1`,
    )
    .get(id) as { id: string } | undefined
  return row?.id ?? null
}

export function listCards(db: DatabaseSync, filter: CardFilter = {}): Card[] {
  const where: string[] = []
  const params: (string | number)[] = []

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
  if (filter.acceptance !== undefined) {
    where.push('owner_acceptance = ?')
    params.push(filter.acceptance ? 1 : 0)
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
    if (patch.ownerAcceptance !== undefined) {
      if (card.status === 'done' || card.status === 'cancelled') {
        throw new UserError(
          3,
          `приёмку карточки ${card.id} нельзя менять в статусе ${card.status}`,
        )
      }
      sets.push('owner_acceptance = ?')
      params.push(patch.ownerAcceptance ? 1 : 0)
    }
    if (patch.ownerAcceptanceManual !== undefined) {
      sets.push('owner_acceptance_manual = ?')
      params.push(patch.ownerAcceptanceManual ? 1 : 0)
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

/** Тег идеи: карточка живёт вне очереди, мержа и ревью. */
export const IDEA_TAG = 'idea'

export function isIdeaCard(card: Card): boolean {
  return card.tags.includes(IDEA_TAG)
}

function ideaTitle(text: string, title?: string): string {
  const explicit = title?.trim()
  if (explicit) return explicit
  const first = text.trim().split(/\r?\n/)[0]?.trim() ?? ''
  return first.length > 80 ? `${first.slice(0, 77)}…` : first
}

/** Идея: карточка группы IDEA, status deferred, без мержа и ревью. */
export function addIdea(
  db: DatabaseSync,
  input: { text: string; title?: string; actor?: string },
): Card {
  return tx(db, () => {
    const text = input.text?.trim() ?? ''
    if (text === '') throw new UserError(3, 'нужен текст идеи')
    const actor = input.actor?.trim() || 'owner'
    const card = createCard(db, {
      group: 'IDEA',
      title: ideaTitle(text, input.title),
      body: text,
      skill: 'owner',
      author: actor,
      tags: [IDEA_TAG],
      needsMerge: false,
    })
    db.prepare(
      "update cards set status = 'deferred', review_required = 0, updated_at = ? where id = ?",
    ).run(nowIso(), card.id)
    const updated = getCard(db, card.id)!
    appendEvent(db, { type: 'idea.added', actor, subject: card.id, after: updated })
    return updated
  })
}

function requireIdea(db: DatabaseSync, id: string): Card {
  const card = getCard(db, id)
  if (!card || !isIdeaCard(card)) throw new UserError(3, `идея ${id} не найдена`)
  return card
}

/** Активные идеи: deferred + тег idea, свежие сверху. */
export function listIdeas(db: DatabaseSync): Card[] {
  return listCards(db, { status: 'deferred', tag: IDEA_TAG }).sort((left, right) => {
    const byTime = right.updatedAt.localeCompare(left.updatedAt)
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id)
  })
}

export function editIdea(
  db: DatabaseSync,
  input: { id: string; text?: string; title?: string; actor?: string },
): Card {
  return tx(db, () => {
    const card = requireIdea(db, input.id)
    const sets: string[] = []
    const params: string[] = []
    if (input.text !== undefined) {
      const text = input.text.trim()
      if (text === '') throw new UserError(3, 'текст идеи пуст')
      sets.push('body = ?')
      params.push(text)
    }
    if (input.title !== undefined) {
      const title = ideaTitle(input.text ?? card.body, input.title)
      if (title === '') throw new UserError(3, 'заголовок идеи пуст')
      sets.push('title = ?')
      params.push(title)
    }
    if (sets.length === 0) return card

    sets.push('updated_at = ?')
    params.push(nowIso())
    db.prepare(`update cards set ${sets.join(', ')} where id = ?`).run(...params, card.id)
    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'idea.edited',
      actor: input.actor?.trim() || 'owner',
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}

/** drop идеи — отмена карточки; идеи нет в очереди и ревью, гасить нечего. */
export function dropIdea(
  db: DatabaseSync,
  input: { id: string; actor?: string },
): Card {
  return tx(db, () => {
    const card = requireIdea(db, input.id)
    const at = nowIso()
    db.prepare(
      "update cards set status = 'cancelled', cancel_reason = ?, updated_at = ? where id = ?",
    ).run('идея убрана', at, card.id)
    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'idea.dropped',
      actor: input.actor?.trim() || 'owner',
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}
