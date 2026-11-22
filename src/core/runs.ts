import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getCard, listCards } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { isSatisfied, listDeps } from './deps.ts'
import { openQuestions } from './discussion.ts'
import { appendEvent } from './events.ts'
import { getExecutor } from './executors.ts'
import { allocateId } from './ids.ts'
import { insertIntoQueue } from './queue.ts'
import { RUN_VARIANTS, variantOf } from './tags.ts'
import type {
  Card,
  Executor,
  Run,
  RunCard,
  RunCardStatus,
  RunSuggestion,
} from './types.ts'

/** Забег держит lease два часа; карточки наследуют срок забега (§8.5). */
export const RUN_LEASE_MS = 2 * 60 * 60 * 1000

const OWNER = 'owner'

/** Карточки, которые ещё держат место в забеге. */
const ACTIVE_CARD_STATUSES: readonly RunCardStatus[] = [
  'planned',
  'booked',
  'in_progress',
  'blocked',
  'done',
  'review',
  'reviewed',
]

interface RunRow {
  id: string
  executor_id: string
  status: string
  created_at: string
  started_at: string | null
  ended_at: string | null
  lease_until: string | null
  review: number
  review_mode: string | null
  note: string | null
}

interface RunCardRow {
  run_id: string
  card_id: string
  position: number
  status: string
}

const toRun = (row: RunRow): Run => ({
  id: row.id,
  executorId: row.executor_id,
  status: row.status as Run['status'],
  createdAt: row.created_at,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  leaseUntil: row.lease_until,
  review: row.review === 1,
  reviewMode: row.review_mode as Run['reviewMode'],
  note: row.note,
})

const toRunCard = (row: RunCardRow): RunCard => ({
  runId: row.run_id,
  cardId: row.card_id,
  position: row.position,
  status: row.status as RunCardStatus,
})

function requireExecutor(db: DatabaseSync, id: string): Executor {
  const executor = getExecutor(db, id)
  if (!executor) throw new UserError(3, `исполнитель ${id} не найден`)
  return executor
}

function requiredActor(raw: string | undefined): string {
  const actor = raw?.trim()
  if (!actor) throw new UserError(3, 'нужен --as <исполнитель>')
  return actor
}

function normalizeCardIds(raw: string[]): string[] {
  const ids = raw.map((id) => id.trim()).filter(Boolean)
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) throw new UserError(3, `карточка ${id} указана дважды`)
    seen.add(id)
  }
  return ids
}

export function getRun(db: DatabaseSync, id: string): Run | null {
  const row = db.prepare('select * from runs where id = ?').get(id) as RunRow | undefined
  return row ? toRun(row) : null
}

export function listRuns(db: DatabaseSync): Run[] {
  const rows = db
    .prepare('select * from runs order by created_at, id')
    .all() as unknown as RunRow[]
  return rows.map(toRun)
}

export function getActiveRun(db: DatabaseSync, executorId: string): Run | null {
  const row = db
    .prepare("select * from runs where executor_id = ? and status = 'active'")
    .get(executorId) as RunRow | undefined
  return row ? toRun(row) : null
}

export function listRunCards(db: DatabaseSync, runId: string): RunCard[] {
  const rows = db
    .prepare('select * from run_cards where run_id = ? order by position, card_id')
    .all(runId) as unknown as RunCardRow[]
  return rows.map(toRunCard)
}

/** Навык owner может взять любую карточку; агент — только свой навык. */
function canTake(executor: Executor, card: Card): boolean {
  return executor.id === OWNER || (card.skill !== null && executor.skills.includes(card.skill))
}

function depsStartable(db: DatabaseSync, card: Card, earlier: Set<string>): boolean {
  return listDeps(db, card.id).every(
    (dep) => earlier.has(dep) || isSatisfied(db, dep),
  )
}

function unmetDeps(db: DatabaseSync, card: Card, earlier: Set<string>): string[] {
  return listDeps(db, card.id).filter(
    (dep) => !earlier.has(dep) && !isSatisfied(db, dep),
  )
}

function requireRunnableCard(db: DatabaseSync, executor: Executor, cardId: string): Card {
  const card = getCard(db, cardId)
  if (!card) throw new UserError(3, `карточка ${cardId} не найдена`)
  if (card.skill === OWNER) {
    throw new UserError(
      3,
      `карточка ${card.id} — owner-карточка: в забег не берётся, её закрывает владелец`,
    )
  }
  if (card.phase === 'request') {
    if (card.status !== 'new' && card.status !== 'shaping') {
      throw new UserError(
        3,
        `запрос ${card.id} в статусе ${card.status}: в забег берётся new или shaping`,
      )
    }
    if (card.holder !== null && card.holder !== executor.id) {
      throw new UserError(3, `запрос ${card.id} разбирает другой исполнитель: ${card.holder}`)
    }
    if (card.runId !== null) {
      throw new UserError(3, `запрос ${card.id} уже в забеге ${card.runId}`)
    }
    if (!canTake(executor, card)) {
      throw new UserError(
        3,
        `навык запроса ${card.id} (${card.skill ?? '-'}) не подходит исполнителю ${executor.id}`,
      )
    }
    return card
  }
  if (card.phase !== 'task') {
    throw new UserError(3, `карточка ${card.id} — запрос: в забег берутся только задачи`)
  }
  if (card.status === 'booked' || card.holder !== null || card.runId !== null) {
    throw new UserError(3, `карточка ${card.id} уже забронирована или удерживается`)
  }
  if (card.status !== 'ready' && card.status !== 'waiting') {
    throw new UserError(
      3,
      `карточка ${card.id} в статусе ${card.status}: в забег берутся ready или waiting`,
    )
  }
  if (!canTake(executor, card)) {
    throw new UserError(
      3,
      `навык карточки ${card.id} (${card.skill ?? '—'}) не подходит исполнителю ${executor.id}`,
    )
  }
  return card
}

/**
 * Карточка для одиночного `take`, без забега: task `ready`/`waiting`, без брони,
 * держателя и `run_id`, зависимости закрыты, навык подходит исполнителю.
 */
export function requireStandaloneCard(
  db: DatabaseSync,
  executorId: string,
  cardId: string,
): Card {
  const executor = requireExecutor(db, executorId)
  const card = requireRunnableCard(db, executor, cardId)
  const unmet = listDeps(db, card.id).filter((dep) => !isSatisfied(db, dep))
  if (unmet.length > 0) {
    throw new UserError(3, `зависимость ${unmet.join(', ')} карточки ${card.id} не закрыта`)
  }
  return card
}

function requireDeps(
  db: DatabaseSync,
  card: Card,
  earlier: Set<string>,
  runId?: string,
): void {
  const unmet = unmetDeps(db, card, earlier)
  if (unmet.length === 0) return

  const where = runId === undefined ? '' : ` в забеге ${runId}`
  throw new UserError(
    3,
    `зависимость ${unmet.join(', ')} карточки ${card.id} не закрыта и не входит раньше${where}`,
  )
}

function bookCard(
  db: DatabaseSync,
  run: Run,
  card: Card,
  position: number,
  actor: string,
): void {
  const updatedAt = nowIso()
  db.prepare(
    `update cards set status = 'booked', holder = ?, run_id = ?, lease_until = ?, updated_at = ?
     where id = ?`,
  ).run(run.executorId, run.id, run.leaseUntil, updatedAt, card.id)

  db.prepare(
    `insert into run_cards (run_id, card_id, position, status) values (?, ?, ?, 'booked')
     on conflict(run_id, card_id) do update set position = excluded.position, status = excluded.status`,
  ).run(run.id, card.id, position)

  appendEvent(db, {
    type: 'card.booked',
    actor,
    subject: card.id,
    before: card,
    after: getCard(db, card.id),
    note: `забег ${run.id}`,
  })
}

/** Запрос в забеге: planned, фаза/статус/держатель не меняются. */
function planCard(
  db: DatabaseSync,
  run: Run,
  card: Card,
  position: number,
  actor: string,
): void {
  const updatedAt = nowIso()
  db.prepare('update cards set run_id = ?, updated_at = ? where id = ?').run(
    run.id,
    updatedAt,
    card.id,
  )

  db.prepare(
    `insert into run_cards (run_id, card_id, position, status) values (?, ?, ?, 'planned')
     on conflict(run_id, card_id) do update set position = excluded.position, status = excluded.status`,
  ).run(run.id, card.id, position)

  appendEvent(db, {
    type: 'card.planned',
    actor,
    subject: card.id,
    before: card,
    after: getCard(db, card.id),
    note: `забег ${run.id}: запрос разбирается первым`,
  })
}

/** Возвращает карточку в очередь: ready, если зависимости уже закрыты, иначе waiting. */
function releaseCard(
  db: DatabaseSync,
  card: Card,
  actor: string,
  note: string,
): void {
  const ready = listDeps(db, card.id).every((dep) => isSatisfied(db, dep))
  const status = ready ? 'ready' : 'waiting'
  db.prepare(
    `update cards set status = ?, holder = null, run_id = null, lease_until = null, updated_at = ?
     where id = ?`,
  ).run(status, nowIso(), card.id)

  const released = getCard(db, card.id)!
  if (released.phase === 'task' && released.position === null) {
    insertIntoQueue(db, card.id)
  }

  appendEvent(db, {
    type: 'card.released',
    actor,
    subject: card.id,
    before: card,
    after: getCard(db, card.id),
    note,
  })
}

/** Заблокированная карточка остаётся blocked, но перестаёт принадлежать забегу. */
function detachBlockedCard(
  db: DatabaseSync,
  card: Card,
  actor: string,
  note: string,
): void {
  db.prepare(
    `update cards set holder = null, run_id = null, lease_until = null, updated_at = ?
     where id = ?`,
  ).run(nowIso(), card.id)

  appendEvent(db, {
    type: 'card.released',
    actor,
    subject: card.id,
    before: card,
    after: getCard(db, card.id),
    note,
  })
}

function closeRun(
  db: DatabaseSync,
  run: Run,
  status: Run['status'],
  endedAt: string,
  review: boolean,
  reviewMode: Run['reviewMode'],
  note: string | null,
): Run {
  db.prepare(
    'update runs set status = ?, ended_at = ?, review = ?, review_mode = ?, note = ? where id = ?',
  ).run(status, endedAt, review ? 1 : 0, reviewMode, note, run.id)
  return getRun(db, run.id)!
}

function releaseRunCards(
  db: DatabaseSync,
  run: Run,
  actor: string,
  reason: string,
): void {
  for (const row of listRunCards(db, run.id)) {
    const card = getCard(db, row.cardId)
    if (!card) continue

    if (row.status === 'planned') {
      db.prepare('update cards set run_id = null, updated_at = ? where id = ?').run(nowIso(), card.id)
      db.prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?").run(
        run.id,
        row.cardId,
      )
      continue
    }

    if (row.status === 'blocked' || card.status === 'blocked') {
      detachBlockedCard(db, card, actor, `${reason}: заблокирована`)
      db.prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?").run(
        run.id,
        row.cardId,
      )
      continue
    }

    if (card.status === 'booked' || card.status === 'in_progress') {
      releaseCard(db, card, actor, reason)
      db.prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?").run(
        run.id,
        row.cardId,
      )
    }
  }
}

/**
 * Предложение забега §8.1: верхняя доступная карточка, затем та же группа до
 * `run_size`, затем другие группы. waiting-карточка попадает в забег только
 * после своей зависимости. Предложения непересекающиеся; ничего не бронируют.
 */
export function suggestRuns(
  db: DatabaseSync,
  executorId: string,
  count = 3,
): RunSuggestion[] {
  const executor = requireExecutor(db, executorId)
  if (!Number.isInteger(count) || count < 1) {
    throw new UserError(3, 'количество предложений — целое число от 1')
  }

  const candidates = listCards(db, { phase: 'task', status: ['ready', 'waiting'] })
    .filter((card) => card.position !== null)
    .filter((card) => card.skill !== OWNER)
    .filter((card) => card.holder === null && card.runId === null)
    .filter((card) => canTake(executor, card))
    .sort(
      (left, right) =>
        left.position! - right.position! ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )

  const used = new Set<string>()
  const suggestions: RunSuggestion[] = []

  for (let index = 0; index < count; index++) {
    const anchor = candidates.find(
      (card) => !used.has(card.id) && depsStartable(db, card, new Set()),
    )
    if (!anchor) break

    const chosen: Card[] = [anchor]
    const chosenIds = new Set<string>([anchor.id])
    used.add(anchor.id)

    let progress = true
    while (chosen.length < executor.runSize && progress) {
      progress = false

      for (const sameGroup of [true, false]) {
        for (const candidate of candidates) {
          if (chosen.length >= executor.runSize) break
          if (used.has(candidate.id)) continue
          if (sameGroup ? candidate.group !== anchor.group : candidate.group === anchor.group) {
            continue
          }
          if (!depsStartable(db, candidate, chosenIds)) continue

          chosen.push(candidate)
          chosenIds.add(candidate.id)
          used.add(candidate.id)
          progress = true
        }
      }
    }

    suggestions.push({ executorId, cards: chosen, group: anchor.group })
  }

  return suggestions
}

/**
 * Вероятные забеги по вариантам: new, improve, review. Запросы идут первыми,
 * затем задачи по position. До runSize карточек на вариант, без fallback.
 */
export function suggestVariantRuns(
  db: DatabaseSync,
  executorId: string,
  options: { group?: string; skill?: string; runSize?: number } = {},
): RunSuggestion[] {
  const executor = requireExecutor(db, executorId)
  if (executorId === OWNER) return []

  const runSize = options.runSize ?? executor.runSize
  const requests = listCards(db, {
    phase: 'request',
    status: ['new', 'shaping'],
    group: options.group,
    skill: options.skill,
  })
    .filter((card) => card.skill !== OWNER && canTake(executor, card))
    .filter((card) => card.runId === null && (card.holder === null || card.holder === executorId))
    .sort(
      (left, right) =>
        (left.position ?? Number.MAX_SAFE_INTEGER) -
          (right.position ?? Number.MAX_SAFE_INTEGER) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )

  const tasks = listCards(db, {
    phase: 'task',
    status: ['ready', 'waiting'],
    group: options.group,
    skill: options.skill,
  })
    .filter(
      (card) =>
        card.position !== null &&
        card.holder === null &&
        card.runId === null &&
        card.skill !== OWNER &&
        canTake(executor, card),
    )
    .sort(
      (left, right) =>
        left.position! - right.position! ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )

  const candidates = [...requests, ...tasks]
  const used = new Set<string>()
  const suggestions: RunSuggestion[] = []

  for (const variant of RUN_VARIANTS) {
    const chosen: Card[] = []
    const chosenIds = new Set<string>()

    for (const card of candidates) {
      if (chosen.length >= runSize) break
      if (used.has(card.id)) continue
      if (variantOf(card)?.tag !== variant.tag) continue
      if (!depsStartable(db, card, chosenIds)) continue

      chosen.push(card)
      chosenIds.add(card.id)
      used.add(card.id)
    }

    if (chosen.length > 0) {
      suggestions.push({
        executorId,
        cards: chosen,
        group: chosen[0].group,
        tag: variant.tag,
        label: variant.label,
      })
    }
  }

  return suggestions
}
export function startRun(
  db: DatabaseSync,
  input: {
    executorId: string
    cardIds: string[]
    actor: string
    reviewMode?: Run['reviewMode']
  },
): Run {
  return tx(db, () => {
    const actor = requiredActor(input.actor)
    const executor = requireExecutor(db, input.executorId)
    const cardIds = normalizeCardIds(input.cardIds)

    if (cardIds.length === 0) {
      throw new UserError(3, 'для забега нужна хотя бы одна карточка')
    }
    if (cardIds.length > executor.runSize) {
      throw new UserError(
        3,
        `на старте не больше ${executor.runSize} карточек, а передано ${cardIds.length}`,
      )
    }

    const active = getActiveRun(db, executor.id)
    if (active) {
      throw new UserError(
        3,
        `у исполнителя ${executor.id} уже есть активный забег ${active.id}`,
      )
    }

    const cards: Card[] = []
    const earlier = new Set<string>()
    for (const cardId of cardIds) {
      const card = requireRunnableCard(db, executor, cardId)
      requireDeps(db, card, earlier)
      cards.push(card)
      earlier.add(card.id)
    }

    const now = new Date()
    const createdAt = nowIso(now)
    const leaseUntil = new Date(now.getTime() + RUN_LEASE_MS).toISOString()
    const run: Run = {
      id: allocateId(db, 'run'),
      executorId: executor.id,
      status: 'active',
      createdAt,
      startedAt: createdAt,
      endedAt: null,
      leaseUntil,
      review: false,
      reviewMode: input.reviewMode ?? null,
      note: null,
    }

    db.prepare(
      `insert into runs (id, executor_id, status, created_at, started_at, ended_at, lease_until, review, review_mode, note)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.executorId,
      run.status,
      run.createdAt,
      run.startedAt,
      run.endedAt,
      run.leaseUntil,
      run.review ? 1 : 0,
      run.reviewMode,
      run.note,
    )

    cards.forEach((card, index) => {
      if (card.phase === 'request') planCard(db, run, card, index + 1, actor)
      else bookCard(db, run, card, index + 1, actor)
    })

    appendEvent(db, {
      type: 'run.started',
      actor,
      subject: run.id,
      after: getRun(db, run.id),
      note: cards.map((card) => card.id).join(', '),
    })

    return getRun(db, run.id)!
  })
}

export function addToRun(
  db: DatabaseSync,
  input: { executorId: string; cardId: string; actor: string },
): void {
  tx(db, () => {
    const actor = requiredActor(input.actor)
    const executor = requireExecutor(db, input.executorId)
    const run = getActiveRun(db, executor.id)
    if (!run) {
      throw new UserError(3, `у исполнителя ${executor.id} нет активного забега`)
    }

    const existingCard = getCard(db, input.cardId)
    if (!existingCard) throw new UserError(3, `карточка ${input.cardId} не найдена`)

    const rows = listRunCards(db, run.id)
    const existing = rows.find((row) => row.cardId === input.cardId)
    if (existing && existing.status !== 'dropped') {
      throw new UserError(3, `карточка ${input.cardId} уже в забеге ${run.id}`)
    }

    const card = requireRunnableCard(db, executor, input.cardId)

    // Размер забега ограничен только на старте: дальше он растёт свободно.
    const active = rows.filter((row) => ACTIVE_CARD_STATUSES.includes(row.status))

    requireDeps(db, card, new Set(active.map((row) => row.cardId)), run.id)

    const position =
      active.reduce((max, row) => Math.max(max, row.position), 0) + 1
    if (card.phase === 'request') planCard(db, run, card, position, actor)
    else bookCard(db, run, card, position, actor)
  })
}

export function dropFromRun(
  db: DatabaseSync,
  input: { executorId: string; cardId: string; actor: string },
): void {
  tx(db, () => {
    const actor = requiredActor(input.actor)
    const run = getActiveRun(db, input.executorId)
    if (!run) {
      throw new UserError(3, `у исполнителя ${input.executorId} нет активного забега`)
    }

    const row = listRunCards(db, run.id).find((item) => item.cardId === input.cardId)
    if (!row) {
      throw new UserError(3, `карточка ${input.cardId} не в забеге ${run.id}`)
    }

    const card = getCard(db, input.cardId)
    if (!card) throw new UserError(3, `карточка ${input.cardId} не найдена`)

    if (row.status === 'in_progress' || card.status === 'in_progress') {
      throw new UserError(
        3,
        `карточка ${card.id} в работе: сначала finish или block`,
      )
    }
    if (row.status === 'planned') {
      db.prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?").run(
        run.id,
        card.id,
      )
      db.prepare('update cards set run_id = null, updated_at = ? where id = ?').run(
        nowIso(),
        card.id,
      )
      appendEvent(db, {
        type: 'card.planned_dropped',
        actor,
        subject: card.id,
        before: card,
        after: getCard(db, card.id),
        note: `снят с забега ${run.id}`,
      })
      return
    }
    if (row.status === 'blocked' || card.status === 'blocked') {
      // Решение владельца «blocked» сохраняется; карточка лишь покидает забег,
      // чтобы после approve её можно было вернуть тем же `run add`.
      db.prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?").run(
        run.id,
        card.id,
      )
      detachBlockedCard(db, card, actor, `снята с забега ${run.id}`)
      return
    }
    if (row.status !== 'booked' || card.status !== 'booked') {
      throw new UserError(3, `карточка ${card.id} не забронирована в ${run.id}`)
    }

    db.prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?").run(
      run.id,
      card.id,
    )
    releaseCard(db, card, actor, `снята с забега ${run.id}`)
  })
}

/**
 * Следующая карточка забега §8.3: только booked, зависимости закрыты или
 * закрыты раньше в этом забеге. blocked и in_progress пропускаются.
 */
export function nextCard(
  db: DatabaseSync,
  input: { executorId: string },
): Card | null {
  const run = getActiveRun(db, input.executorId)
  if (!run) return null

  const rows = listRunCards(db, run.id)

  for (const row of rows) {
    if (row.status !== 'blocked') continue
    const card = getCard(db, row.cardId)
    if (!card || card.phase !== 'request' || card.runId !== run.id) continue
    if (card.status === 'blocked' || openQuestions(db, card.id).length > 0) continue

    // Отвеченный запрос — в голову, позиции снова 1..N.
    db.prepare(
      "update run_cards set status = 'planned', position = 1 where run_id = ? and card_id = ?",
    ).run(run.id, card.id)
    let position = 2
    for (const item of rows) {
      if (item.cardId === card.id) continue
      db.prepare('update run_cards set position = ? where run_id = ? and card_id = ?').run(
        position++,
        run.id,
        item.cardId,
      )
    }
    return card
  }

  for (const row of rows) {
    if (row.status !== 'planned') continue
    const card = getCard(db, row.cardId)
    if (!card || card.phase !== 'request' || card.runId !== run.id) continue
    if (card.status === 'blocked' || openQuestions(db, card.id).length > 0) continue
    return card
  }

  for (const row of rows) {
    if (row.status !== 'booked') continue

    const card = getCard(db, row.cardId)
    if (!card || card.status !== 'booked') continue

    const completedEarlier = new Set(
      rows
        .filter(
          (item) =>
            item.position < row.position &&
            (item.status === 'done' || item.status === 'review'),
        )
        .map((item) => item.cardId),
    )
    if (!depsStartable(db, card, completedEarlier)) continue

    return card
  }

  return null
}

export function endRun(
  db: DatabaseSync,
  input: {
    executorId: string
    actor: string
    reviewMode?: Run['reviewMode']
    /** Старый булев флаг: true = subagent, false = none. */
    review?: boolean
  },
): Run {
  return tx(db, () => {
    const actor = requiredActor(input.actor)
    const run = getActiveRun(db, input.executorId)
    if (!run) {
      throw new UserError(3, `у исполнителя ${input.executorId} нет активного забега`)
    }

    const rows = listRunCards(db, run.id)
    const inProgress = rows.some(
      (row) =>
        row.status === 'in_progress' ||
        getCard(db, row.cardId)?.status === 'in_progress',
    )
    if (inProgress) {
      throw new UserError(
        3,
        `в забеге ${run.id} есть карточки в работе: сначала finish или block`,
      )
    }

    const reviewMode =
      input.reviewMode ??
      (input.review === true ? 'subagent' : input.review === false ? 'none' : null) ??
      run.reviewMode ??
      'none'

    releaseRunCards(db, run, actor, `забег ${run.id} закрыт`)

    // Пост-фактум ревью: карточки уже done, но забег просит проверить plan и код.
    if (reviewMode !== 'none') {
      for (const row of listRunCards(db, run.id)) {
        const card = getCard(db, row.cardId)
        // Уже отревьюенная карточка имеет run_cards.status='done' после verdict.
        if (!card || row.status !== 'done' || card.status !== 'done') continue
        const before = card
        const at = nowIso()
        db.prepare(
          "update cards set status = 'review', done_at = null, updated_at = ? where id = ?",
        ).run(at, card.id)
        db.prepare("update run_cards set status = 'review' where run_id = ? and card_id = ?").run(
          run.id,
          card.id,
        )
        appendEvent(db, {
          type: 'card.review_requested',
          actor,
          subject: card.id,
          before,
          after: getCard(db, card.id),
          note: `забег ${run.id}: ревью после done`,
        })
      }
    }

    const review = reviewMode !== 'none'
    const ended = closeRun(db, run, 'ended', nowIso(), review, reviewMode, null)

    appendEvent(db, {
      type: 'run.ended',
      actor,
      subject: run.id,
      before: run,
      after: ended,
      note: review ? `ревью запланировано: ${reviewMode}` : 'ревью выключено',
    })

    return ended
  })
}

/**
 * Итоги прохода ревью: один блок текста в `runs.note`. Пишет ревьюер;
 * карточки при этом не создаются — в них остаётся вердикт и ссылка.
 */
export function noteRun(
  db: DatabaseSync,
  input: { runId: string; text: string; actor: string },
): Run {
  return tx(db, () => {
    const actor = requiredActor(input.actor)
    const run = getRun(db, input.runId)
    if (!run) throw new UserError(3, `забег ${input.runId} не найден`)
    const text = input.text.trim()
    if (!text) throw new UserError(3, 'нужен текст итогов: --text «...»')

    db.prepare('update runs set note = ? where id = ?').run(text, run.id)
    const updated = getRun(db, run.id)!

    appendEvent(db, {
      type: 'run.noted',
      actor,
      subject: run.id,
      before: run,
      after: updated,
      note: text,
    })
    return updated
  })
}

/** Ручное снятие брони владельцем §8.5: закрывает забег как cancelled. */
export function releaseRun(
  db: DatabaseSync,
  input: { runId: string; actor: string; reason: string },
): Run {
  return tx(db, () => {
    const actor = requiredActor(input.actor)
    const run = getRun(db, input.runId)
    if (!run) throw new UserError(3, `забег ${input.runId} не найден`)
    if (run.status !== 'active') {
      throw new UserError(3, `забег ${run.id} не активен: ${run.status}`)
    }

    const reason = input.reason.trim()
    if (!reason) throw new UserError(3, 'нужна причина снятия забега: --reason «...»')

    releaseRunCards(db, run, actor, `забег снят: ${reason}`)
    const released = closeRun(
      db,
      run,
      'cancelled',
      nowIso(),
      run.review,
      run.reviewMode,
      reason,
    )

    appendEvent(db, {
      type: 'run.released',
      actor,
      subject: run.id,
      before: run,
      after: released,
      note: reason,
    })

    return released
  })
}

/**
 * Истёкший lease §8.5: забег закрывается как lease_expired, карточки
 * возвращаются в очередь. Ветки и worktree не трогаем — это забота git-слоя.
 */
export function reclaimExpired(db: DatabaseSync, now: Date = new Date()): number {
  return tx(db, () => {
    const cutoff = nowIso(now)
    const rows = db
      .prepare(
        "select * from runs where status = 'active' and lease_until is not null and lease_until < ?",
      )
      .all(cutoff) as unknown as RunRow[]

    for (const row of rows) {
      const run = toRun(row)
      releaseRunCards(db, run, 'system', `lease истёк: ${cutoff}`)
      const expired = closeRun(
        db,
        run,
        'lease_expired',
        cutoff,
        run.review,
        run.reviewMode,
        'lease истёк',
      )

      appendEvent(db, {
        type: 'run.lease_expired',
        actor: 'system',
        subject: run.id,
        before: run,
        after: expired,
        note: cutoff,
      })
    }

    const shapingIds = db
      .prepare(
        "select id from cards where status = 'shaping' and lease_until is not null and lease_until < ? order by created_at, id",
      )
      .all(cutoff) as Array<{ id: string }>

    for (const { id } of shapingIds) {
      const before = getCard(db, id)
      if (!before) continue

      db.prepare(
        "update cards set status = 'new', holder = null, lease_until = null, updated_at = ? where id = ?",
      ).run(cutoff, id)

      appendEvent(db, {
        type: 'card.lease_expired',
        actor: 'system',
        subject: id,
        before,
        after: getCard(db, id),
        note: cutoff,
      })
    }

    // Одиночные карточки без забега: истёкший lease возвращает их в очередь.
    // Карточки в забеге возвращает закрытие забега выше.
    const workingIds = db
      .prepare(
        "select id from cards where run_id is null and status in ('booked', 'in_progress') and lease_until is not null and lease_until < ? order by created_at, id",
      )
      .all(cutoff) as Array<{ id: string }>

    for (const { id } of workingIds) {
      const before = getCard(db, id)
      if (!before) continue
      const ready = listDeps(db, id).every((dep) => isSatisfied(db, dep))

      db.prepare(
        'update cards set status = ?, holder = null, lease_until = null, updated_at = ? where id = ?',
      ).run(ready ? 'ready' : 'waiting', cutoff, id)

      appendEvent(db, {
        type: 'card.lease_expired',
        actor: 'system',
        subject: id,
        before,
        after: getCard(db, id),
        note: cutoff,
      })
    }

    return rows.length + shapingIds.length + workingIds.length
  })
}
