import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getCard, listCards } from './cards.ts'
import { tx } from './db.ts'
import type { Card, CardPhase, CardStatus } from './types.ts'

/**
 * Статусы задачи, которые видны в очереди §5.1. `approval` ждёт владельца;
 * запросы стоят в своей очереди по тем же правилам.
 */
const QUEUE_STATUSES: readonly CardStatus[] = [
  'waiting',
  'ready',
  'booked',
  'in_progress',
  'blocked',
  'review',
]

/** Открытые запросы в очереди заявок: new и shaping. */
const REQUEST_QUEUE_STATUSES: readonly CardStatus[] = ['new', 'shaping']

const QUEUE = new Set<string>(QUEUE_STATUSES)
const REQUEST_QUEUE = new Set<string>(REQUEST_QUEUE_STATUSES)

function queueStatuses(phase: CardPhase): readonly CardStatus[] {
  return phase === 'request' ? REQUEST_QUEUE_STATUSES : QUEUE_STATUSES
}

function inQueue(phase: CardPhase, status: CardStatus): boolean {
  return (phase === 'request' ? REQUEST_QUEUE : QUEUE).has(status)
}

export interface QueueFilter {
  status?: CardStatus | CardStatus[]
  group?: string
  skill?: string
  holder?: string
  limit?: number
}

export interface MoveTarget {
  before?: string
  top?: boolean
  bottom?: boolean
}

/** Оценка из §5.2: `importance × urgency`, у незаполненных оценок — ноль. */
export function score(card: Card): number {
  return (card.importance ?? 0) * (card.urgency ?? 0)
}

/** Место в очереди задаёт `position`; карточка без него в очередь ещё не встала. */
function byPosition(left: Card, right: Card): number {
  return (left.position ?? 0) - (right.position ?? 0)
}

export function listQueue(
  db: DatabaseSync,
  filter: QueueFilter = {},
  phase: CardPhase = 'task',
): Card[] {
  const limit = filter.limit
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 0)) {
    throw new UserError(3, '--limit — целое число от 0')
  }

  const statuses =
    filter.status === undefined
      ? [...queueStatuses(phase)]
      : Array.isArray(filter.status)
        ? filter.status
        : [filter.status]
  if (statuses.length === 0) return []

  const cards = listCards(db, {
    phase,
    status: statuses,
    group: filter.group,
    skill: filter.skill,
    holder: filter.holder,
  })

  const queue = cards
    .filter((card) => inQueue(phase, card.status) && card.position !== null)
    .sort(byPosition)
  return limit === undefined ? queue : queue.slice(0, limit)
}

/**
 * Вставка по оценке §5.2: после последней карточки с оценкой >= новой, при
 * равной оценке — после всех равных. Затем все позиции перенумерованы 1..N.
 * Работает и для задач, и для запросов — у каждого своя очередь.
 */
export function insertIntoQueue(db: DatabaseSync, cardId: string): void {
  tx(db, () => {
    const card = getCard(db, cardId)
    if (!card) throw new UserError(3, `карточка ${cardId} не найдена`)
    const statuses = queueStatuses(card.phase)
    if (!statuses.includes(card.status)) {
      throw new UserError(
        3,
        `карточка ${cardId} в статусе ${card.status}: в очередь ставится ${statuses.join(' или ')}`,
      )
    }
    // Owner-карточки не стоят ни в одной очереди: их закрывает владелец.
    if (card.skill === 'owner') return
    if (card.position !== null) return

    const others = listQueue(db, {}, card.phase).filter((item) => item.id !== cardId)
    const cardScore = score(card)
    let index = 0
    for (let i = 0; i < others.length; i++) {
      if (score(others[i]) >= cardScore) index = i + 1
    }

    renumber(db, [
      ...others.slice(0, index).map((item) => item.id),
      cardId,
      ...others.slice(index).map((item) => item.id),
    ])
  })
}

/**
 * Ручная перестановка §5.3: карточка снимается с текущего места и встаёт в
 * цель; позиции, как и при вставке, перенумеровываются.
 */
export function moveCard(db: DatabaseSync, id: string, target: MoveTarget): void {
  tx(db, () => {
    const card = getCard(db, id)
    if (!card) throw new UserError(3, `карточка ${id} не найдена`)

    const queue = listQueue(db, {}, card.phase)
    if (!queue.some((item) => item.id === id)) {
      throw new UserError(3, `карточка ${id} не в очереди`)
    }

    const targets =
      Number(target.before !== undefined) +
      Number(target.top === true) +
      Number(target.bottom === true)
    if (targets !== 1) {
      throw new UserError(3, 'укажите одно из: --before ID, --top, --bottom')
    }

    const others = queue.filter((item) => item.id !== id)
    let index: number

    if (target.top === true) {
      index = 0
    } else if (target.bottom === true) {
      index = others.length
    } else {
      const before = target.before!
      if (before === id) return
      if (!getCard(db, before)) throw new UserError(3, `карточка ${before} не найдена`)
      const at = others.findIndex((item) => item.id === before)
      if (at === -1) throw new UserError(3, `карточка ${before} не в очереди`)
      index = at
    }

    renumber(db, [
      ...others.slice(0, index).map((item) => item.id),
      id,
      ...others.slice(index).map((item) => item.id),
    ])
  })
}

/**
 * Явный пересчёт порядка по оценкам: внутри равных сохраняется текущий
 * порядок, поэтому ручные сдвиги не теряются.
 */
export function reorderQueue(db: DatabaseSync): void {
  tx(db, () => {
    const ordered = listQueue(db).sort(
      (left, right) =>
        score(right) - score(left) ||
        (left.position ?? Number.MAX_SAFE_INTEGER) -
          (right.position ?? Number.MAX_SAFE_INTEGER),
    )
    renumber(db, ordered.map((card) => card.id))
  })
}

function renumber(db: DatabaseSync, ids: string[]): void {
  const update = db.prepare('update cards set position = ? where id = ?')
  ids.forEach((id, index) => update.run(index + 1, id))
}
