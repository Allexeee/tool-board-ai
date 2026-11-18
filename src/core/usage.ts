import { existsSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Учёт токенов по агентам.
 *
 * Источник — база самого OpenCode (`session_v2`). Читаем её только на чтение и
 * только если она и таблица существуют: «нет данных» и «нули» — разные ответы,
 * и врать нулями нельзя.
 */

/** Цена за миллион токенов: тариф проекта нужен, когда база пишет cost = 0 (подписка). */
export interface Tariff {
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

/** Блок `pricing` в конфиге проекта: тариф и, при желании, лимит. */
export interface Pricing extends Tariff {
  budget?: number
  agents?: Record<string, Tariff>
}

export type UsageBasis = 'cost' | 'tariff' | 'share'

export interface AgentUsage {
  agent: string
  sessions: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** Все токены сессий агента, включая кеш: по ним считается доля, когда тарифа нет. */
  tokens: number
  /** Стоимость, записанная в базе OpenCode. */
  cost: number
  /** Деньги: cost из базы, а при cost = 0 — цена по тарифу из конфига. */
  amount: number
  percent: number | null
}

export interface UsageTotals {
  sessions: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  cost: number
  amount: number
}

export interface UsageReport {
  available: true
  dbPath: string
  agents: AgentUsage[]
  totals: UsageTotals
  budget: number | null
  basis: UsageBasis
  /** Почему процент именно такой: «тариф не задан», «бюджет не задан» и т. п. */
  note: string | null
}

export interface UsageUnavailable {
  available: false
  dbPath: string
  reason: string
}

export type UsageResult = UsageReport | UsageUnavailable

/** Окно прогона в epoch ms: `from` — начало, `until` — конец открытого окна ещё не наступил. */
export interface UsageWindow {
  from?: number
  until?: number
}

export interface UsageOptions {
  /** Путь к базе OpenCode. В тестах подменяется: настоящую базу не трогаем. */
  dbPath?: string
  pricing?: Pricing | null | undefined
  budget?: number | null | undefined
  env?: NodeJS.ProcessEnv
  /** Каталог проекта: сессии чужих проектов в расход не попадают. */
  projectDir?: string
  /** Окно активного прогона: считается только то, что жило внутри него. */
  window?: UsageWindow | null
}

/** База OpenCode лежит в каталоге данных пользователя, а не в проекте. */
export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const dataHome = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share')
  return join(dataHome, 'opencode', 'opencode.db')
}

interface Row {
  agent: string
  sessions: number
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
}

/** Сессия как её пишет OpenCode: складываем сами, чтобы отфильтровать проект и окно. */
interface SessionRow {
  agent: string | null
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost: number
  directory: string | null
  timeCreated: number | null
  timeUpdated: number | null
}

/**
 * Старые базы OpenCode могут не знать части колонок — читаем то, что есть.
 * Без directory сессию не отнести к проекту, поэтому такая строка при фильтре отсеивается.
 */
function readSessions(db: DatabaseSync): SessionRow[] {
  const names = new Set(
    (db.prepare('pragma table_info(session_v2)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  )
  const optional = (name: string): string => (names.has(name) ? name : 'null')

  return db
    .prepare(
      `select agent,
              coalesce(tokens_input, 0) as input,
              coalesce(tokens_output, 0) as output,
              coalesce(tokens_reasoning, 0) as reasoning,
              coalesce(tokens_cache_read, 0) as cacheRead,
              coalesce(tokens_cache_write, 0) as cacheWrite,
              coalesce(cost, 0) as cost,
              ${optional('directory')} as directory,
              ${optional('time_created')} as timeCreated,
              ${optional('time_updated')} as timeUpdated
         from session_v2`,
    )
    .all() as unknown as SessionRow[]
}

const hasTable = (db: DatabaseSync, name: string): boolean =>
  Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name))

/** Путь проекта в одном виде: прямые слэши, без хвоста, Windows — без регистра. */
export function normalizeDirectory(value: string): string {
  const slashed = value.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:/.test(slashed) ? slashed.toLowerCase() : slashed
}

/**
 * Свои сессии — каталог проекта и его рабочие каталоги фич.
 * project_id не годится: у одного каталога в базе встречается несколько id.
 */
export function belongsToProject(directory: string | null, project: string): boolean {
  if (!directory) return false
  const session = normalizeDirectory(directory)
  return session === project || session.startsWith(`${project}/.worktrees/`)
}

/**
 * Сессия попала в окно, если жила внутри него. Токены в сессии накопительные,
 * поэтому сессия, начатая до прогона и обновлённая в нём, входит целиком.
 */
function insideWindow(row: SessionRow, window: UsageWindow): boolean {
  const created = row.timeCreated
  const updated = row.timeUpdated ?? created
  if (window.from !== undefined && (updated === null || updated < window.from)) return false
  if (window.until !== undefined && (created === null || created > window.until)) return false
  return true
}

/** Свёртка сессий по агентам: пустое имя — «без агента», а не потерянная строка. */
function groupByAgent(rows: SessionRow[]): Row[] {
  const byAgent = new Map<string, Row>()
  for (const row of rows) {
    const agent = row.agent?.trim() ? row.agent.trim() : 'без агента'
    const current = byAgent.get(agent) ?? {
      agent,
      sessions: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
    }
    current.sessions += 1
    current.input += row.input
    current.output += row.output
    current.reasoning += row.reasoning
    current.cacheRead += row.cacheRead
    current.cacheWrite += row.cacheWrite
    current.cost += row.cost
    byAgent.set(agent, current)
  }
  return [...byAgent.values()]
}

/** Цена токенов агента по тарифу; агент может переопределить тариф проекта. */
function priceOf(tariff: Tariff | undefined, row: Row): number {
  if (!tariff) return 0
  const perMillion =
    row.input * (tariff.input ?? 0) +
    row.output * (tariff.output ?? 0) +
    row.reasoning * (tariff.reasoning ?? 0) +
    row.cacheRead * (tariff.cacheRead ?? 0) +
    row.cacheWrite * (tariff.cacheWrite ?? 0)
  return perMillion / 1e6
}

const round = (value: number): number => Math.round(value * 10) / 10

const share = (part: number, total: number): number | null => (total > 0 ? round((part / total) * 100) : null)

/** Пустой блок `pricing` — не тариф: иначе проценты молча превратятся в нули. */
function hasRates(pricing: Pricing | null): pricing is Pricing {
  if (!pricing) return false
  const rates = [pricing.input, pricing.output, pricing.reasoning, pricing.cacheRead, pricing.cacheWrite]
  if (rates.some((rate) => typeof rate === 'number' && rate > 0)) return true
  return Object.values(pricing.agents ?? {}).some((tariff) =>
    [tariff.input, tariff.output, tariff.reasoning, tariff.cacheRead, tariff.cacheWrite].some(
      (rate) => typeof rate === 'number' && rate > 0,
    ),
  )
}

/**
 * Читает учёт из базы OpenCode и группирует его по агентам.
 * Ничего не пишет: открывает базу read-only.
 */
export function readUsage(options: UsageOptions = {}): UsageResult {
  const dbPath = options.dbPath ?? opencodeDbPath(options.env)
  // бюджет — отдельно от ставок: тариф может быть не задан, а лимит задан
  const requestedBudget = options.budget ?? options.pricing?.budget ?? null
  const pricing = hasRates(options.pricing ?? null) ? options.pricing ?? null : null
  const budget =
    requestedBudget !== null && Number.isFinite(requestedBudget) && requestedBudget > 0 ? requestedBudget : null

  if (!existsSync(dbPath)) {
    return { available: false, dbPath, reason: `учёт недоступен: база OpenCode не найдена — ${dbPath}` }
  }

  let db: DatabaseSync
  try {
    // read-only: чужую базу смотрим, но не меняем
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return {
      available: false,
      dbPath,
      reason: `учёт недоступен: база OpenCode не открылась — ${(error as Error).message}`,
    }
  }

  try {
    // битый или чужой файл: любая ошибка sqlite здесь — это «учёт недоступен», а не падение
    if (!hasTable(db, 'session_v2')) {
      return { available: false, dbPath, reason: `учёт недоступен: в базе нет таблицы session_v2 — ${dbPath}` }
    }

    const project = options.projectDir ? normalizeDirectory(options.projectDir) : null
    const window = options.window ?? null
    const rows = groupByAgent(
      readSessions(db).filter(
        (row) =>
          (project === null || belongsToProject(row.directory, project)) &&
          (window === null || insideWindow(row, window)),
      ),
    )

    const agents = rows.map((row): AgentUsage => {
      const tokens = row.input + row.output + row.reasoning + row.cacheRead + row.cacheWrite
      const override = pricing?.agents?.[row.agent]
      const tariff = override ? { ...pricing, ...override } : (pricing ?? undefined)
      return {
        agent: row.agent,
        sessions: row.sessions,
        input: row.input,
        output: row.output,
        reasoning: row.reasoning,
        cacheRead: row.cacheRead,
        cacheWrite: row.cacheWrite,
        tokens,
        cost: row.cost,
        amount: row.cost > 0 ? row.cost : priceOf(tariff, row),
        percent: null,
      }
    })

    const totals = agents.reduce<UsageTotals>(
      (sum, agent) => ({
        sessions: sum.sessions + agent.sessions,
        input: sum.input + agent.input,
        output: sum.output + agent.output,
        reasoning: sum.reasoning + agent.reasoning,
        cacheRead: sum.cacheRead + agent.cacheRead,
        cacheWrite: sum.cacheWrite + agent.cacheWrite,
        tokens: sum.tokens + agent.tokens,
        cost: sum.cost + agent.cost,
        amount: sum.amount + agent.amount,
      }),
      { sessions: 0, input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, cost: 0, amount: 0 },
    )

    // процент от лимита: настоящие деньги из базы сильнее тарифа, тариф — сильнее доли
    let basis: UsageBasis
    let note: string | null = null

    if (budget !== null) {
      // moneyUsed (amount) уже выбирает: настоящий cost, иначе оценка по тарифу.
      // Считать процент от cost нельзя: при подписке он нулевой у всех.
      basis = totals.cost > 0 ? 'cost' : 'tariff'
      for (const agent of agents) agent.percent = share(agent.amount, budget)
      if (basis === 'tariff' && pricing === null) {
        basis = 'share'
        note = 'тариф не задан: процент — доля агента от общего расхода токенов'
        for (const agent of agents) agent.percent = share(agent.tokens, totals.tokens)
      }
    } else if (totals.cost > 0) {
      basis = 'cost'
      note = 'бюджет не задан: процент — доля агента от общего cost'
      for (const agent of agents) agent.percent = share(agent.cost, totals.cost)
    } else if (pricing !== null) {
      basis = 'tariff'
      note = 'бюджет не задан: процент — доля агента от общего расхода по тарифу'
      for (const agent of agents) agent.percent = share(agent.amount, totals.amount)
    } else {
      basis = 'share'
      note = 'тариф не задан: процент — доля агента от общего расхода токенов'
      for (const agent of agents) agent.percent = share(agent.tokens, totals.tokens)
    }

    agents.sort((a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent))

    return { available: true, dbPath, agents, totals, budget, basis, note }
  } catch (error) {
    return {
      available: false,
      dbPath,
      reason: `учёт недоступен: база OpenCode не читается — ${(error as Error).message}`,
    }
  } finally {
    // битый файл может не закрыться; ответ уже сформирован, падать из-за этого нельзя
    try {
      db.close()
    } catch {
      /* закрытие — не повод менять ответ */
    }
  }
}

/** Живой субагент: дочерняя сессия OpenCode, которая работала в последнее окно. */
export interface LiveSession {
  id: string
  agent: string
  title: string
  /** Последняя отметка «занят» новее последней «простаивает». */
  busy: boolean
  updatedAt: number
}

export interface LiveSessionOptions {
  /** Путь к базе OpenCode. В тестах подменяется: настоящую базу не трогаем. */
  dbPath?: string
  env?: NodeJS.ProcessEnv
  /** Каталог проекта: субагенты чужих проектов на доску не попадают. */
  projectDir?: string
  /** Насколько свежей должна быть сессия; по умолчанию два часа. */
  withinMs?: number
  /** Текущее время в epoch ms: в тестах подменяется. */
  now?: number
}

const LIVE_WINDOW_MS = 2 * 60 * 60 * 1000

/**
 * Субагенты сессии — дочерние строки session_v2, обновлённые за последнее окно.
 * База OpenCode чужая: открываем read-only, а любая беда с ней даёт пустой список,
 * потому что доска должна печататься и без неё.
 */
export function readLiveSessions(options: LiveSessionOptions = {}): LiveSession[] {
  const dbPath = options.dbPath ?? opencodeDbPath(options.env)
  if (!existsSync(dbPath)) return []

  const now = options.now ?? Date.now()
  const within = options.withinMs ?? LIVE_WINDOW_MS
  const project = options.projectDir ? normalizeDirectory(options.projectDir) : null

  let db: DatabaseSync
  try {
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch {
    return []
  }

  try {
    if (!hasTable(db, 'session_v2')) return []

    const names = new Set(
      (db.prepare('pragma table_info(session_v2)').all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    )
    // без родителя и времени сессию не отличить от обычной и не проверить свежесть
    if (!names.has('parent_id') || !names.has('time_updated')) return []

    const optional = (name: string): string => (names.has(name) ? name : 'null')
    const archived = names.has('time_archived') ? 'and time_archived is null' : ''
    const rows = db
      .prepare(
        `select id,
                ${optional('agent')} as agent,
                ${optional('title')} as title,
                ${optional('directory')} as directory,
                time_updated as updatedAt,
                ${optional('time_busy')} as busyAt,
                ${optional('time_idle')} as idleAt
           from session_v2
          where parent_id is not null ${archived}`,
      )
      .all() as unknown as Array<{
      id: string
      agent: string | null
      title: string | null
      directory: string | null
      updatedAt: number | null
      busyAt: number | null
      idleAt: number | null
    }>

    return rows
      .filter((row) => typeof row.updatedAt === 'number' && row.updatedAt >= now - within)
      .filter((row) => project === null || belongsToProject(row.directory, project))
      .map((row) => ({
        id: row.id,
        agent: row.agent?.trim() || 'без агента',
        title: (row.title ?? '').trim(),
        busy: (row.busyAt ?? 0) > (row.idleAt ?? 0),
        updatedAt: row.updatedAt as number,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  } catch {
    return []
  } finally {
    try {
      db.close()
    } catch {
      /* битая база не повод падать */
    }
  }
}
