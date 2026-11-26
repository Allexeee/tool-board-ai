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

/** Класс очереди — навык карточки; пустой навык идёт в общую очередь. */
export type QueueClass = string

export interface QueueFilter {
  status?: CardStatus | CardStatus[]
  group?: string
  skill?: string
  holder?: string
  limit?: number
  /** Класс очереди: карточки разных навыков нумеруются отдельно. */
  class?: QueueClass
}

export function cardQueueClass(card: Card): QueueClass {
  return card.skill?.trim() || 'executors'
}

function classRank(left: string, right: string): number {
  if (left === right) return 0
  if (left === 'owner') return -1
  if (right === 'owner') return 1
  return left.localeCompare(right)
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

  const queueClass = filter.class
  const queue = cards
    .filter((card) => inQueue(phase, card.status))
    .filter((card) => card.position !== null)
    .filter((card) => queueClass === undefined || cardQueueClass(card) === queueClass)
    .sort(
      (left, right) =>
        (queueClass === undefined
          ? classRank(cardQueueClass(left), cardQueueClass(right))
          : 0) ||
        (left.position ?? Number.MAX_SAFE_INTEGER) -
          (right.position ?? Number.MAX_SAFE_INTEGER) ||
        (right.importance ?? 0) - (left.importance ?? 0) ||
        left.createdAt.localeCompare(right.createdAt) ||
        left.id.localeCompare(right.id),
    )
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
    if (card.position !== null) return

    // Owner-очередь отдельная и только для задач: новая карточка встаёт в конец.
    if (card.skill === 'owner') {
      if (card.phase !== 'task') return
      const owner = listQueue(db, { class: 'owner' }, card.phase).filter(
        (item) => item.id !== cardId && item.position !== null,
      )
      renumber(db, [...owner.map((item) => item.id), cardId])
      return
    }

    const others = listQueue(db, { class: cardQueueClass(card) }, card.phase)
      .filter((item) => item.id !== cardId && item.position !== null)
      .sort(
        (left, right) =>
          score(right) - score(left) ||
          (left.position ?? Number.MAX_SAFE_INTEGER) -
            (right.position ?? Number.MAX_SAFE_INTEGER),
      )
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

    const queueClass = cardQueueClass(card)
    const queue = listQueue(db, { class: queueClass }, card.phase)
    const oldIndex = queue.findIndex((item) => item.id === id)
    if (oldIndex === -1) {
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
      const targetCard = getCard(db, before)
      if (!targetCard) throw new UserError(3, `карточка ${before} не найдена`)
      if (cardQueueClass(targetCard) !== queueClass) {
        throw new UserError(3, `${id} и ${before} в разных очередях`)
      }
      const at = others.findIndex((item) => item.id === before)
      if (at === -1) throw new UserError(3, `карточка ${before} не в очереди`)
      index = at
    }

    // Демон растёт только при ручном понижении, не при подъёме.
    if (index > oldIndex) {
      db.prepare('update cards set demons = demons + 1 where id = ?').run(id)
    }

    renumber(db, [
      ...others.slice(0, index).map((item) => item.id),
      id,
      ...others.slice(index).map((item) => item.id),
    ])
  })
}

/**
 * Пересборка нумерации: ручной порядок (`position`) сохраняется, оценки —
 * только тайбрейк для карточек без позиции.
 */
export function reorderQueue(db: DatabaseSync): void {
  tx(db, () => {
    normalizeClasses(db, listQueue(db), false)
    normalizeClasses(
      db,
      listCards(db, { phase: 'request', status: ['new', 'shaping'] }).filter(
        (card) => card.skill !== 'owner',
      ),
      true,
    )
  })
}

function normalizeClasses(db: DatabaseSync, cards: Card[], requests: boolean): void {
  const groups = new Map<string, Card[]>()
  for (const card of cards) {
    const key = cardQueueClass(card)
    groups.set(key, [...(groups.get(key) ?? []), card])
  }
  for (const [key, group] of groups) {
    const sorted = [...group].sort((left, right) =>
      requests
        ? score(right) - score(left) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id)
        : key === 'owner'
          ? (left.position ?? Number.MAX_SAFE_INTEGER) -
              (right.position ?? Number.MAX_SAFE_INTEGER) ||
            (right.importance ?? 0) - (left.importance ?? 0) ||
            left.createdAt.localeCompare(right.createdAt) ||
            left.id.localeCompare(right.id)
          : (left.position ?? Number.MAX_SAFE_INTEGER) -
              (right.position ?? Number.MAX_SAFE_INTEGER) ||
            score(right) - score(left),
    )
    if (sorted.length > 0) renumber(db, sorted.map((card) => card.id))
  }
}

/** Миграция старых позиций: внутри каждого навыка 1..N, порядок сохраняется. */
export function ensureSkillQueues(db: DatabaseSync): void {
  tx(db, () => {
    const groups = new Map<string, Card[]>()
    const statuses = QUEUE_STATUSES.filter((status) => status !== 'blocked')
    for (const card of listCards(db, { phase: 'task', status: statuses })) {
      const key = cardQueueClass(card)
      groups.set(key, [...(groups.get(key) ?? []), card])
    }
    for (const [key, group] of groups) {
      const sorted = [...group].sort(
        (left, right) =>
          (left.position ?? Number.MAX_SAFE_INTEGER) -
            (right.position ?? Number.MAX_SAFE_INTEGER) ||
          (key === 'owner'
            ? (right.importance ?? 0) - (left.importance ?? 0)
            : score(right) - score(left)) ||
          left.createdAt.localeCompare(right.createdAt) ||
          left.id.localeCompare(right.id),
      )
      if (sorted.length > 0) renumber(db, sorted.map((card) => card.id))
    }
  })
}

function renumber(db: DatabaseSync, ids: string[]): void {
  const update = db.prepare('update cards set position = ? where id = ?')
  ids.forEach((id, index) => update.run(index + 1, id))
}
