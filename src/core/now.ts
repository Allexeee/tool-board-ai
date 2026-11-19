import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { listCards } from './cards.ts'
import { todayStartIso } from './clock.ts'
import { openQuestions, type Discussion } from './discussion.ts'
import { listExecutors } from './executors.ts'
import { listQueue } from './queue.ts'
import { getActiveRun, listRunCards, listRuns, reclaimExpired, suggestRuns } from './runs.ts'
import type { Card, CardPhase, CardStatus, Run, RunCard, RunSuggestion } from './types.ts'

/** Вкладка доски `now` (§11): 0 — владельцу, 1 — мои забеги, 2 — все забеги, 3 — открытые карточки. */
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

export interface NowRun {
  run: Run
  cards: RunCard[]
}

export interface NowView {
  view: NowViewKind
  header: NowHeader
  executor?: string
  approvals?: Card[]
  ownerCards?: Card[]
  questions?: Discussion[]
  currentRun?: NowRun | null
  suggestions?: RunSuggestion[]
  runs?: Run[]
  requests?: Card[]
  queue?: Card[]
  moreQueue?: number
  moreRequests?: number
}

export interface NowOptions {
  view: NowViewKind
  executorId: string
  filters?: NowFilters
  /** Корень проекта: зарезервирован под обновление `in_dev`/`in_main` из git. */
  root?: string
}

const OWNER = 'owner'
const REQUEST_LIMIT = 10
const QUEUE_LIMIT = 15

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
  if (view === 1) return { view, header, ...myRuns(db, executorId) }
  if (view === 2) return { view, header, ...allRuns(db, executorId) }
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
function ownerView(db: DatabaseSync): Pick<NowView, 'approvals' | 'ownerCards' | 'questions'> {
  const approvals = listCards(db, { status: 'approval' })
  const ownerCards = listCards(db, { skill: 'owner', status: 'ready' }).sort(
    (left, right) =>
      (right.importance ?? -1) - (left.importance ?? -1) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  )
  const questions = openQuestions(db)
  return { approvals, ownerCards, questions }
}

/**
 * Вкладка «мои забеги» §11.3: текущий активный забег, затем вероятные следующие.
 * Владельцу текущего забега не показываем: у него нет своих забегов, только
 * по одному предложению на агента.
 */
function myRuns(db: DatabaseSync, executorId: string): Pick<NowView, 'executor' | 'currentRun' | 'suggestions'> {
  if (executorId === OWNER) {
    const suggestions: RunSuggestion[] = []
    for (const agent of listExecutors(db)) {
      if (agent.id === OWNER) continue
      const [suggestion] = suggestRuns(db, agent.id, 1)
      if (suggestion) suggestions.push(suggestion)
      if (suggestions.length >= 3) break
    }
    return { executor: executorId, currentRun: null, suggestions }
  }

  const active = getActiveRun(db, executorId)
  const currentRun: NowRun | null = active
    ? { run: active, cards: listRunCards(db, active.id) }
    : null

  return {
    executor: executorId,
    currentRun,
    suggestions: suggestRuns(db, executorId, 3),
  }
}

/** Вкладка «все забеги» §11.4: активные и завершённые + по предложению на чужого. */
function allRuns(db: DatabaseSync, executorId: string): Pick<NowView, 'runs' | 'suggestions'> {
  const runs = listRuns(db).filter((run) => run.status === 'active' || run.status === 'ended')
  const suggestions: RunSuggestion[] = []
  for (const executor of listExecutors(db)) {
    if (executor.id === OWNER || executor.id === executorId) continue
    const [suggestion] = suggestRuns(db, executor.id, 1)
    if (suggestion) suggestions.push(suggestion)
  }
  return { runs, suggestions }
}

/** Вкладка открытых карточек §11.1: запросы и очередь с лимитами и счётчиками «ещё». */
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
    const requests = listCards(db, {
      phase: 'request',
      status: filters.status,
      group: filters.group,
      skill: filters.skill,
      holder,
    })
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

const VIEW_TITLES: Record<NowViewKind, string> = {
  0: 'ВЛАДЕЛЬЦУ',
  1: 'МОИ ЗАБЕГИ',
  2: 'ЗАБЕГИ',
  3: 'ОТКРЫТЫЕ КАРТОЧКИ',
}

const STATUS_WORDS: Record<CardStatus, string> = {
  new: 'new',
  shaping: 'разбор',
  approval: 'на утверждении',
  waiting: 'ждёт',
  ready: 'доступна',
  booked: 'забронирована',
  in_progress: 'в работе',
  blocked: 'заблокирована',
  review: 'на ревью',
  done: 'сделано',
  cancelled: 'отменена',
}

const RUN_STATUS_WORDS: Record<Run['status'], string> = {
  active: 'в работе',
  ended: 'завершён',
  cancelled: 'отменён',
  lease_expired: 'lease истёк',
}

const RUN_CARD_STATUS_WORDS: Record<RunCard['status'], string> = {
  booked: 'забронирована',
  in_progress: 'в работе',
  done: 'done',
  review: 'review',
  blocked: 'blocked',
  dropped: 'снята',
}

/** Текстовый набросок доски §11. Цвет не обязателен; вывод читается в пайпе. */
export function renderNow(data: NowView): string {
  const lines: string[] = [titleLine(data)]
  if (data.view === 3) renderOpen(lines, data)
  else if (data.view === 0) renderOwner(lines, data)
  else if (data.view === 1) renderMyRuns(lines, data)
  else renderAllRuns(lines, data)
  return lines.join('\n')
}

function titleLine(data: NowView): string {
  if (data.view === 1) {
    const executors = [...new Set((data.suggestions ?? []).map((run) => run.executorId))]
    const executor =
      data.executor && data.executor !== OWNER
        ? data.executor
        : executors.length === 1
          ? executors[0]
          : undefined
    return executor ? `[1] МОИ ЗАБЕГИ — ${executor}` : '[1] МОИ ЗАБЕГИ'
  }
  return `[${data.view}] ${VIEW_TITLES[data.view]}`
}

function renderOpen(lines: string[], data: NowView): void {
  const { header } = data
  lines.push(`СДЕЛАНО СЕГОДНЯ: ${header.doneToday} · dev опережает main на ${header.devAhead}`)
  lines.push('ПОСЛЕДНИЕ 5 DONE')
  for (const card of header.lastDone) {
    lines.push(`  ${card.id.padEnd(7)} ${card.title}  ${card.skill ?? ''}`)
  }

  if (data.requests && data.requests.length > 0) {
    lines.push(`ЗАПРОСЫ (${data.requests.length})`)
    for (const card of data.requests) {
      const holder = card.holder ? ` ${card.holder}` : ''
      lines.push(`  ${card.id.padEnd(7)} ${card.title}  ${STATUS_WORDS[card.status]}${holder}`)
    }
    if (data.moreRequests) lines.push('  ...')
  }

  if (data.queue && data.queue.length > 0) {
    lines.push(`ОЧЕРЕДЬ (${data.queue.length})`)
    for (const card of data.queue) {
      const holder = card.holder ? ` ${card.holder}` : ''
      lines.push(
        `  ${String(card.position).padStart(2)}  ${card.id.padEnd(7)} ${card.title}  ` +
          `${STATUS_WORDS[card.status]}${holder}`,
      )
    }
    if (data.moreQueue) lines.push('  ...')
  }
}

function renderOwner(lines: string[], data: NowView): void {
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
      lines.push(`  ${card.id.padEnd(7)} ${card.title}  owner`)
    }
  }
  if (data.questions && data.questions.length > 0) {
    lines.push(`ВОПРОСЫ (${data.questions.length})`)
    for (const question of data.questions) {
      lines.push(`  ${question.cardId.padEnd(7)} ${question.text}  спрашивает ${question.author}`)
    }
  }
}

function renderMyRuns(lines: string[], data: NowView): void {
  const current = data.currentRun
  if (current) {
    const cards = current.cards
      .map((card) => `${card.cardId} (${RUN_CARD_STATUS_WORDS[card.status]})`)
      .join(', ')
    lines.push(
      `ТЕКУЩИЙ ЗАБЕГ  ${current.run.id}  ${cards || '—'}  ${RUN_STATUS_WORDS[current.run.status]}`,
    )
  }

  const suggestions = data.suggestions ?? []
  if (suggestions.length > 0 && current) lines.push('СЛЕДУЮЩИЕ')
  const multi = new Set(suggestions.map((run) => run.executorId)).size > 1
  suggestions.forEach((run, index) => {
    const who = multi ? `  ${run.executorId}` : ''
    const cards = run.cards.map((card) => card.id).join(', ')
    lines.push(`ЗАБЕГ ${index + 1}  ${cards}  (${run.group ?? '—'})${who}`)
  })

  if (!current && suggestions.length === 0) lines.push('забегов нет')
}

function renderAllRuns(lines: string[], data: NowView): void {
  for (const run of data.runs ?? []) {
    lines.push(`${run.id}  ${run.executorId}  ${RUN_STATUS_WORDS[run.status]}`)
  }
  const suggestions = data.suggestions ?? []
  if (suggestions.length > 0) {
    lines.push('СЛЕДУЮЩИЕ')
    for (const run of suggestions) {
      lines.push(`  ${run.executorId}  ${run.cards.map((card) => card.id).join(', ')}`)
    }
  }
}
