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

export interface UsageOptions {
  /** Путь к базе OpenCode. В тестах подменяется: настоящую базу не трогаем. */
  dbPath?: string
  pricing?: Pricing | null | undefined
  budget?: number | null | undefined
  env?: NodeJS.ProcessEnv
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

const GROUP_SQL = `
  select coalesce(nullif(trim(agent), ''), 'без агента') as agent,
         count(*) as sessions,
         coalesce(sum(tokens_input), 0) as input,
         coalesce(sum(tokens_output), 0) as output,
         coalesce(sum(tokens_reasoning), 0) as reasoning,
         coalesce(sum(tokens_cache_read), 0) as cacheRead,
         coalesce(sum(tokens_cache_write), 0) as cacheWrite,
         coalesce(sum(cost), 0) as cost
    from session_v2
   group by 1
   order by 1
`

const hasTable = (db: DatabaseSync, name: string): boolean =>
  Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name))

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
  const pricing = hasRates(options.pricing ?? null) ? options.pricing ?? null : null
  const requestedBudget = options.budget ?? pricing?.budget ?? null
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
    if (!hasTable(db, 'session_v2')) {
      return { available: false, dbPath, reason: `учёт недоступен: в базе нет таблицы session_v2 — ${dbPath}` }
    }

    let rows: Row[]
    try {
      rows = db.prepare(GROUP_SQL).all() as unknown as Row[]
    } catch (error) {
      return {
        available: false,
        dbPath,
        reason: `учёт недоступен: таблица session_v2 не читается — ${(error as Error).message}`,
      }
    }

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

    if (budget !== null && totals.cost > 0) {
      basis = 'cost'
      for (const agent of agents) agent.percent = share(agent.cost, budget)
    } else if (budget !== null && pricing !== null) {
      basis = 'tariff'
      for (const agent of agents) agent.percent = share(agent.amount, budget)
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
  } finally {
    db.close()
  }
}
