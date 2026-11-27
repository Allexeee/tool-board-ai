import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { paint, type ColorName } from '../cli/output.ts'
import { listCards } from './cards.ts'
import { todayStartIso } from './clock.ts'
import { openQuestions, type Discussion } from './discussion.ts'
import { getExecutor, listExecutors } from './executors.ts'
import { listQueue, score } from './queue.ts'
import { reclaimExpired, suggestVariantRuns } from './runs.ts'
import { variantOf } from './tags.ts'
import type { Card, CardPhase, CardStatus } from './types.ts'

/** Вкладка доски `now` (§11): 0 — владельцу, 1 — мои задачи, 2 — все агенты, 3 — запросы и очередь. */
export type NowViewKind = 0 | 1 | 2 | 3

export interface NowHeader {
  doneToday: number
  devAhead: number
  lastDone: Card[]
}

export interface NowFilters {
  group?: string
  status?: CardStatus | CardStatus[]
  skill?: string
  mine?: boolean
  phase?: CardPhase
  limit?: number
  all?: boolean
}

/** Карточки одного агента: запрос и задача — одна карточка с разным статусом. */
export interface NowAgentTasks {
  id: string
  skills: string[]
  cards: Card[]
}

export interface NowProbableCard {
  card: Card
  request: boolean
}

export interface NowProbableRun {
  tag: string
  label: string
  cards: NowProbableCard[]
}

export interface NowView {
  view: NowViewKind
  header: NowHeader
  executor?: string
  skills?: string[]
  cards?: Card[]
  queue?: Card[]
  probableRuns?: NowProbableRun[]
  untagged?: number
  executors?: NowAgentTasks[]
  approvals?: Card[]
  ownerCards?: Card[]
  questions?: Discussion[]
  requests?: Card[]
  moreQueue?: number
  moreRequests?: number
  deferredCount?: number
  reviewCount?: number
  acceptanceCount?: number
}

export interface NowOptions {
  view: NowViewKind
  executorId: string
  filters?: NowFilters
  /** Корень проекта: зарезервирован под обновление `in_dev`/`in_main` из git. */
  root?: string
}

export interface NowRenderOptions {
  /** Цвет — украшение: включается только когда CLI уже решил, что терминал живой. */
  color?: boolean
}

const OWNER = 'owner'
const REQUEST_LIMIT = 10
const QUEUE_LIMIT = 15

/** Карточки, которые агент уже держит. */
const CURRENT_STATUSES: readonly CardStatus[] = ['booked', 'in_progress', 'blocked', 'review', 'acceptance']

/** Незанятые задачи, которые стоят в очереди. */
const OPEN_QUEUE_STATUSES: readonly CardStatus[] = ['ready', 'waiting']

/** Запросы, которые ещё открыты: отменённые и закрытые не показываем. */
const OPEN_REQUEST_STATUSES: readonly CardStatus[] = ['new', 'shaping', 'blocked']

/** Порядок карточек в едином списке: сначала в работе/ревью, затем доступные. */
const CARD_ORDER: Record<string, number> = {
  in_progress: 0,
  booked: 1,
  ready: 2,
  waiting: 3,
  review: 4,
  acceptance: 5,
  blocked: 6,
  new: 7,
  shaping: 8,
}

/**
 * Снимок доски §11. Перед чтением снимает истёкшие lease (§8.5), чтобы очереди
 * не показывали зависшие брони. Заголовок считается всегда, содержимое — по вкладке.
 */
export function nowData(db: DatabaseSync, options: NowOptions): NowView {
  const view = options.view
  if (view < 0 || view > 3) {
    throw new UserError(3, `вкладка now — 0, 1, 2 или 3, а не «${view}»`)
  }

  reclaimExpired(db)

  const header = computeHeader(db)
  const executorId = options.executorId
  const filters = options.filters ?? {}

  if (view === 0) return { view, header, ...ownerView(db) }
  if (view === 1) return { view, header, ...agentView(db, executorId, filters) }
  if (view === 2) return { view, header, ...allAgentsView(db, executorId, filters) }
  return { view, header, ...openCards(db, executorId, filters) }
}

/**
 * Заголовок (§11.1): сделано сегодня — done с `done_at` сегодняшних суток;
 * dev опережает main — `needs_merge` в `dev`, не в `main` и без revert (§7.3);
 * последние пять done — по `done_at` по убыванию.
 */
function computeHeader(db: DatabaseSync): NowHeader {
  const all = listCards(db)
  const start = todayStartIso()

  const done = all.filter((card) => card.status === 'done' && card.doneAt !== null)
  const doneToday = done.filter((card) => card.doneAt! >= start).length
  const devAhead = all.filter(
    (card) => card.needsMerge && card.inDev && !card.inMain && card.revertedAt === null,
  ).length
  const lastDone = [...done]
    .sort((left, right) => right.doneAt!.localeCompare(left.doneAt!))
    .slice(0, 5)

  return { doneToday, devAhead, lastDone }
}

/** Вкладка владельцу §11.2: на утверждении, owner-карточки в ready, открытые вопросы. */
function ownerView(
  db: DatabaseSync,
): Pick<
  NowView,
  'approvals' | 'ownerCards' | 'questions' | 'deferredCount' | 'reviewCount' | 'acceptanceCount'
> {
  const approvals = listCards(db, { status: 'approval' })
  const acceptance = listCards(db, { status: 'acceptance' }).sort(
    (left, right) =>
      (right.importance ?? -1) - (left.importance ?? -1) ||
      left.createdAt.localeCompare(right.createdAt) ||
      byGroupSeq(left, right),
  )
  const ownerCards = listCards(db, { skill: 'owner', status: ['ready', 'waiting'] }).sort(
    (left, right) =>
      (left.position ?? Number.MAX_SAFE_INTEGER) -
        (right.position ?? Number.MAX_SAFE_INTEGER) ||
      (right.importance ?? -1) - (left.importance ?? -1) ||
      left.createdAt.localeCompare(right.createdAt) ||
      byGroupSeq(left, right),
  )
  const questions = openQuestions(db)
  const deferredCount = listCards(db, { status: 'deferred' }).length
  const reviewCount = listCards(db, { status: 'review' }).length
  return {
    approvals,
    ownerCards: [...acceptance, ...ownerCards],
    questions,
    deferredCount,
    reviewCount,
    acceptanceCount: acceptance.length,
  }
}

/** Вкладка «мои задачи» §11.3: карточки на руках и очередь по навыкам агента. */
function agentView(
  db: DatabaseSync,
  executorId: string,
  filters: NowFilters,
): Pick<NowView, 'executor' | 'skills' | 'cards' | 'probableRuns' | 'untagged'> {
  const executor = getExecutor(db, executorId)
  const skills = executor?.skills ?? []
  if (executorId === OWNER) {
    return {
      executor: executorId,
      skills,
      cards: [],
      probableRuns: [],
      untagged: 0,
    }
  }
  const cards = cardsForAgent(db, executor, filters)
  const probableRuns = suggestVariantRuns(db, executorId, {
    group: filters.group,
    skill: filters.skill,
  }).map((run) => ({
    tag: run.tag ?? '',
    label: run.label ?? '',
    cards: run.cards.map((card) => ({ card, request: card.phase === 'request' })),
  }))
  const untagged = cards.filter((card) => variantOf(card) === null).length
  return { executor: executorId, skills, cards, probableRuns, untagged }
}

/** Вкладка «задачи по агентам» §11.4: по блоку на каждого другого исполнителя. */
function allAgentsView(
  db: DatabaseSync,
  executorId: string,
  filters: NowFilters,
): Pick<NowView, 'executors'> {
  const executors: NowAgentTasks[] = []
  for (const executor of listExecutors(db)) {
    if (executor.id === OWNER || executor.id === executorId) continue
    const cards = cardsForAgent(db, executor, filters)
    if (cards.length === 0) continue
    executors.push({ id: executor.id, skills: executor.skills, cards })
  }
  return { executors }
}

/**
 * Единый список карточек агента: на руках, задача в очереди и запрос.
 * Запрос и задача — одна карточка с разным статусом.
 */
function cardsForAgent(
  db: DatabaseSync,
  executor: ReturnType<typeof getExecutor>,
  filters: NowFilters,
): Card[] {
  if (!executor) return []
  const skills = executor.skills

  const current = listCards(db, {
    phase: 'task',
    status: [...CURRENT_STATUSES],
    holder: executor.id,
    group: filters.group,
    skill: filters.skill,
  })

  const queue = listCards(db, {
    phase: 'task',
    status: [...OPEN_QUEUE_STATUSES],
    group: filters.group,
    skill: filters.skill,
  }).filter(
    (card) =>
      card.holder === null &&
      card.skill !== null &&
      skills.includes(card.skill),
  )

  const requests = listCards(db, {
    phase: 'request',
    status: [...OPEN_REQUEST_STATUSES],
    group: filters.group,
    skill: filters.skill,
  }).filter(
    (card) =>
      card.skill !== null &&
      skills.includes(card.skill) &&
      (card.holder === null || card.holder === executor.id),
  )

  const byId = new Map<string, Card>()
  for (const card of [...current, ...queue, ...requests]) byId.set(card.id, card)
  return [...byId.values()].sort(byCardOrder)
}

function byGroupSeq(left: Card, right: Card): number {
  return left.groupSeq - right.groupSeq || left.id.localeCompare(right.id)
}

function byCardOrder(left: Card, right: Card): number {
  return (
    (CARD_ORDER[left.status] ?? 9) - (CARD_ORDER[right.status] ?? 9) ||
    Number(left.position === null) - Number(right.position === null) ||
    (left.position ?? 0) - (right.position ?? 0) ||
    score(right) - score(left) ||
    left.createdAt.localeCompare(right.createdAt) ||
    byGroupSeq(left, right)
  )
}

/** Вкладка запросов и очереди §11.5: только открытые запросы с лимитами и счётчиками. */
function openCards(
  db: DatabaseSync,
  executorId: string,
  filters: NowFilters,
): Pick<NowView, 'requests' | 'queue' | 'moreQueue' | 'moreRequests'> {
  const all = filters.all === true
  const showRequests = filters.phase === undefined || filters.phase === 'request'
  const showQueue = filters.phase === undefined || filters.phase === 'task'
  const holder = filters.mine ? executorId : undefined

  const result: Pick<NowView, 'requests' | 'queue' | 'moreQueue' | 'moreRequests'> = {}

  if (showRequests) {
    const limit = all ? Infinity : (filters.limit ?? REQUEST_LIMIT)
    const requested = filters.status === undefined ? [...OPEN_REQUEST_STATUSES] : asStatuses(filters.status)
    const statuses = requested.filter((status) => OPEN_REQUEST_STATUSES.includes(status))
    const requests = statuses.length === 0
      ? []
      : listCards(db, {
          phase: 'request',
          status: statuses,
          group: filters.group,
          skill: filters.skill,
          holder,
        }).sort(
          (left, right) =>
            (left.position ?? Number.MAX_SAFE_INTEGER) -
              (right.position ?? Number.MAX_SAFE_INTEGER) ||
            left.createdAt.localeCompare(right.createdAt) ||
            byGroupSeq(left, right),
        )
    result.requests = requests.slice(0, limit)
    result.moreRequests = requests.length > limit ? requests.length - limit : 0
  }

  if (showQueue) {
    const limit = all ? Infinity : (filters.limit ?? QUEUE_LIMIT)
    const queue = listQueue(db, {
      status: filters.status,
      group: filters.group,
      skill: filters.skill,
      holder,
    })
    result.queue = queue.slice(0, limit)
    result.moreQueue = queue.length > limit ? queue.length - limit : 0
  }

  return result
}

function asStatuses(value: CardStatus | CardStatus[]): CardStatus[] {
  return Array.isArray(value) ? value : [value]
}

const VIEW_TITLES: Record<NowViewKind, string> = {
  0: 'ЗАДАЧИ ДЛЯ МЕНЯ',
  1: 'МОИ ЗАДАЧИ',
  2: 'ЗАДАЧИ ПО АГЕНТАМ',
  3: 'ЗАПРОСЫ И ОЧЕРЕДЬ',
}

const STATUS_WORDS: Record<CardStatus, string> = {
  new: 'новая',
  shaping: 'разбор',
  approval: 'на утверждении',
  waiting: 'ждёт',
  ready: 'в очереди',
  booked: 'забронирована',
  in_progress: 'в работе',
  blocked: 'заблокирована',
  deferred: 'отложена',
  review: 'ждёт финального ревью',
  acceptance: 'ожидает приёмки',
  done: 'сделано',
  cancelled: 'отменена',
}

/** Цвет статуса: спокойные — серые, живые — цветные, проблема — жёлтая. */
const STATUS_COLORS: Partial<Record<CardStatus, ColorName>> = {
  new: 'gray',
  shaping: 'gray',
  waiting: 'gray',
  ready: 'green',
  booked: 'cyan',
  in_progress: 'cyan',
  review: 'magenta',
  acceptance: 'yellow',
  blocked: 'yellow',
  deferred: 'gray',
  approval: 'yellow',
  done: 'green',
  cancelled: 'gray',
}

const AGENT_COLORS: readonly ColorName[] = ['cyan', 'magenta', 'green', 'yellow']

type Painter = (text: string, color: ColorName) => string

const noPaint: Painter = (text) => text

function makePainter(color: boolean): Painter {
  if (!color) return noPaint
  return (text, name) => paint(text, name, { isTTY: true, env: {} })
}

function agentColor(id: string): ColorName {
  let hash = 0
  for (const char of id) hash = (hash * 31 + char.codePointAt(0)!) >>> 0
  return AGENT_COLORS[hash % AGENT_COLORS.length]
}

/** Текстовый набросок доски §11. Цвет не обязателен; вывод читается в пайпе. */
export function renderNow(data: NowView, options: NowRenderOptions = {}): string {
  const painter = makePainter(options.color === true)
  const lines: string[] = [titleLine(data)]
  if (data.view === 3) renderOpen(lines, data, painter)
  else if (data.view === 0) renderOwner(lines, data, painter)
  else if (data.view === 1) renderAgentTasks(lines, data, painter)
  else renderAllTasks(lines, data, painter)
  return lines.join('\n')
}

function titleLine(data: NowView): string {
  return `[${data.view}] ${VIEW_TITLES[data.view]}`
}

function renderAgentTasks(lines: string[], data: NowView, painter: Painter): void {
  if (data.executor === OWNER) {
    lines.push('владельцу — now 0')
    return
  }
  renderCards(lines, data.cards ?? [], painter)
  renderProbableRuns(lines, data, painter)
}

function renderProbableRuns(lines: string[], data: NowView, painter: Painter): void {
  const runs = data.probableRuns ?? []
  if (runs.length > 0) {
    lines.push('ВЕРОЯТНЫЕ ЗАБЕГИ')
    for (const run of runs) {
      lines.push(`  ${run.label}`)
      for (const item of run.cards) {
        const mark = item.request ? painter('?', 'yellow') : ' '
        lines.push(`    ${mark}  ${item.card.id.padEnd(7)} ${item.card.title}`)
      }
    }
  }
  if ((data.untagged ?? 0) > 0) lines.push(`  БЕЗ ТЕГА: ${data.untagged}`)
}

function renderAllTasks(lines: string[], data: NowView, painter: Painter): void {
  const executors = data.executors ?? []
  if (executors.length === 0) {
    lines.push('задач нет')
    return
  }
  for (const executor of executors) {
    lines.push('', painter(executor.id, agentColor(executor.id)))
    renderCards(lines, executor.cards, painter)
  }
}

function renderCards(lines: string[], cards: Card[], painter: Painter): void {
  if (cards.length === 0) {
    lines.push('карточек нет')
    return
  }
  lines.push(`КАРТОЧКИ (${cards.length})`)
  for (const card of cards) lines.push(cardLine(card, painter))
}

function cardLine(card: Card, painter: Painter): string {
  const status = painter(STATUS_WORDS[card.status], STATUS_COLORS[card.status] ?? 'gray')
  return `  ${card.id.padEnd(7)} ${card.title}  ${status}`
}

function renderOpen(lines: string[], data: NowView, painter: Painter): void {
  const { header } = data
  lines.push(`СДЕЛАНО СЕГОДНЯ: ${header.doneToday} · dev опережает main на ${header.devAhead}`)
  lines.push('ПОСЛЕДНИЕ 5 DONE')
  for (const card of header.lastDone) {
    lines.push(`  ${card.id.padEnd(7)} ${card.title}  ${card.skill ?? ''}`)
  }

  if (data.requests && data.requests.length > 0) {
    lines.push(`ЗАПРОСЫ (${data.requests.length})`)
    for (const card of data.requests) {
      const holder = card.holder ? ` ${painter(card.holder, agentColor(card.holder))}` : ''
      lines.push(`  ${card.id.padEnd(7)} ${card.title}  ${statusWord(card, painter)}${holder}`)
    }
    if (data.moreRequests) lines.push('  ...')
  }

  if (data.queue && data.queue.length > 0) {
    lines.push(`ОЧЕРЕДЬ (${data.queue.length})`)
    for (const card of data.queue) {
      const holder = card.holder ? ` ${painter(card.holder, agentColor(card.holder))}` : ''
      lines.push(
        `  ${String(card.position).padStart(2)}  ${card.id.padEnd(7)} ${card.title}  ` +
          `${statusWord(card, painter)}${holder}  · ${card.skill ?? 'executors'}`,
      )
    }
    if (data.moreQueue) lines.push('  ...')
  }
}

function renderOwner(lines: string[], data: NowView, painter: Painter): void {
  if (data.approvals && data.approvals.length > 0) {
    lines.push(`УТВЕРДИТЬ (${data.approvals.length})`)
    for (const card of data.approvals) {
      lines.push(
        `  ${card.id.padEnd(7)} ${card.title}  ${card.skill ?? ''}  ` +
          `важность ${card.importance ?? 0}, срочность ${card.urgency ?? 0}`,
      )
    }
  }
  if (data.ownerCards && data.ownerCards.length > 0) {
    lines.push(`ЗАДАЧИ (${data.ownerCards.length})`)
    for (const card of data.ownerCards) {
      const mark = card.status === 'acceptance' ? '  · ждёт приёмки' : ''
      lines.push(`  ${card.id.padEnd(7)} ${card.title}${mark}`)
    }
  }
  if (data.questions && data.questions.length > 0) {
    lines.push(`ВОПРОСЫ (${data.questions.length})`)
    for (const question of data.questions) {
      lines.push(
        `  ${question.cardId.padEnd(7)} ${question.text}  спрашивает ` +
          painter(question.author, agentColor(question.author)),
      )
    }
  }
  if (data.deferredCount && data.deferredCount > 0) {
    lines.push(`ОТЛОЖЕНО (${data.deferredCount})`)
  }
  if (data.reviewCount && data.reviewCount > 0) {
    lines.push(`НА РЕВЬЮ (${data.reviewCount})`)
  }
}

function statusWord(card: Card, painter: Painter): string {
  return painter(STATUS_WORDS[card.status], STATUS_COLORS[card.status] ?? 'gray')
}
