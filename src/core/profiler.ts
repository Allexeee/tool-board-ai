import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { readConfig, type Config } from './config.ts'
import { listExecutors } from './executors.ts'
import { activeRun } from './runs.ts'
import { opencodeDbPath, type Pricing } from './usage.ts'

// ─── профайлер прогона: замер, который можно сравнить ───────────────────────
//
// Владелец хочет видеть разницу между «1 агент», «2 агента» и «3 агента».
// Замер — файл-маркер в .toolbox-al/reports: метка, начало, прогон и состав
// исполнителей. Статистика не пишется в трекер: источник — база самого
// OpenCode, её читаем только на чтение и только в окне замера.

const REPORTS_DIR = ['.toolbox-al', 'reports'] as const
const MARKER_PREFIX = 'profiler-'
const MARKER_SUFFIX = '.json'

/** Лимит по умолчанию, если в конфиге не задан: 60 — та же цифра, что в заказе. */
export const DEFAULT_BUDGET = 60

/** Откуда взялась цена: cost из базы, тариф конфига или её нет вовсе. */
export type PriceBasis = 'cost' | 'tariff' | 'none'

/** Исполнитель на момент старта: состав замера — снимок, а не текущий список. */
export interface ProfileExecutor {
  id: string
  kind: string
  skills: string[]
  model: string | null
}

export interface ProfileMarker {
  /** Метка владельца: «2 агента», «без субагентов» — по ней и сравнивают. */
  label: string
  startedAt: string
  /** null — замер идёт; ISO — закрыт. */
  endedAt: string | null
  /** Прогон, если он был активен на старте замера. */
  run: string | null
  executors: ProfileExecutor[]
}

export interface StoredMarker extends ProfileMarker {
  path: string
}

export interface AgentProfile {
  agent: string
  sessions: number
  /** Время работы в окне, мс; null — в базе нет отметок занятости. */
  busyMs: number | null
  /** Время простоя в окне, мс; null — в базе нет отметок простоя. */
  idleMs: number | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  /** Стоимость, записанная в базе OpenCode. */
  cost: number
  /** Цена: cost из базы, иначе по тарифу; null — тариф не задан. */
  amount: number | null
  /** Процент от месячного лимита; null — цена не посчитана. */
  percent: number | null
  basis: PriceBasis
}

export interface ProfileTotals {
  sessions: number
  busyMs: number | null
  idleMs: number | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  cost: number
  amount: number | null
  percent: number | null
}

export interface ProfileAvailable {
  available: true
  dbPath: string
  /** Месячный лимит: из pricing.budget или DEFAULT_BUDGET. */
  budget: number
  /** Чем посчитана цена: cost из базы, тарифом конфига или ничем. */
  basis: PriceBasis
  agents: AgentProfile[]
  totals: ProfileTotals
  /** Почему время работы, простой или цена не посчитаны; null — всё на месте. */
  note: string | null
}

export interface ProfileUnavailable {
  available: false
  dbPath: string
  reason: string
}

export type ProfileWindow = ProfileAvailable | ProfileUnavailable

export type ProfileEnd = {
  marker: StoredMarker
  durationMs: number
} & ProfileWindow

export interface StartOptions {
  root: string
  label?: string | undefined
  now?: Date
}

export interface EndOptions {
  root: string
  /** Путь к базе OpenCode. В тестах подменяется: настоящую базу не трогаем. */
  dbPath?: string | undefined
  /** Блок `pricing` из конфига проекта: ставки за миллион токенов и лимит. */
  pricing?: Pricing | null | undefined
  now?: Date
}

const reportsDir = (root: string): string => join(root, ...REPORTS_DIR)

const pad = (value: number, length = 2): string => String(value).padStart(length, '0')

/** Дата в имени маркера — местная и с миллисекундами: два замера не затирают друг друга. */
function fileStamp(at: Date): string {
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-` +
    `${pad(at.getMilliseconds(), 3)}`
  )
}

/** Человеческая отметка времени в сообщениях: та же, что владелец видит в отчётах. */
function stamp(iso: string): string {
  const at = new Date(iso)
  return (
    `${pad(at.getDate())}.${pad(at.getMonth() + 1)}.${at.getFullYear()} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}`
  )
}

function readMarker(path: string): ProfileMarker | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Partial<ProfileMarker>
    if (typeof parsed.label !== 'string' || typeof parsed.startedAt !== 'string') return null
    return {
      label: parsed.label,
      startedAt: parsed.startedAt,
      endedAt: typeof parsed.endedAt === 'string' ? parsed.endedAt : null,
      run: typeof parsed.run === 'string' ? parsed.run : null,
      executors: Array.isArray(parsed.executors) ? (parsed.executors as ProfileExecutor[]) : [],
    }
  } catch {
    return null
  }
}

/** Все маркеры, старые первыми. Чужой или испорченный файл в каталоге отчётов не наш. */
export function listProfiles(root: string): StoredMarker[] {
  const dir = reportsDir(root)
  if (!existsSync(dir)) return []

  const markers: StoredMarker[] = []
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(MARKER_PREFIX) || !name.endsWith(MARKER_SUFFIX)) continue
    const path = join(dir, name)
    const marker = readMarker(path)
    if (marker) markers.push({ ...marker, path })
  }

  return markers.sort(
    (a, b) => a.startedAt.localeCompare(b.startedAt) || a.path.localeCompare(b.path),
  )
}

export function lastProfile(root: string): StoredMarker | null {
  const markers = listProfiles(root)
  return markers.length > 0 ? markers[markers.length - 1]! : null
}

function writeMarker(path: string, marker: ProfileMarker): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, JSON.stringify(marker, null, 2) + '\n', 'utf8')
}

/**
 * Начать замер: маркер с меткой, временем, активным прогоном и составом
 * исполнителей. Второй старт без `profiler end` — отказ: иначе маркер
 * закрылся бы не тем концом, а сравнение потеряло бы окно.
 */
export function startProfile(db: DatabaseSync, options: StartOptions): StoredMarker {
  const now = options.now ?? new Date()
  const open = lastProfile(options.root)
  if (open && open.endedAt === null) {
    throw new UserError(
      1,
      `замер «${open.label}» ещё идёт (начат ${stamp(open.startedAt)}): сначала profiler end`,
    )
  }

  const label = options.label?.trim() ? options.label.trim() : 'замер'
  const marker: ProfileMarker = {
    label,
    startedAt: now.toISOString(),
    endedAt: null,
    run: activeRun(db)?.id ?? null,
    executors: listExecutors(db).map((executor) => ({
      id: executor.id,
      kind: executor.kind,
      skills: executor.skills,
      model: executor.model,
    })),
  }

  const path = join(reportsDir(options.root), `${MARKER_PREFIX}${fileStamp(now)}${MARKER_SUFFIX}`)
  writeMarker(path, marker)

  return { ...marker, path }
}

const hasTable = (db: DatabaseSync, name: string): boolean =>
  Boolean(db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name))

function columnsOf(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`pragma table_info(${table})`).all() as unknown as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

interface SessionRow {
  agent: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  created: number | null
  updated: number
  busy: number | null
  idle: number | null
}

const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Пересечение отрезка [from, to] с окном замера: за пределами окна не считаем. */
function overlap(from: number, to: number, since: number, until: number): number {
  return Math.max(0, Math.min(to, until) - Math.max(from, since))
}

/** Тариф задан, только если есть хотя бы одна положительная ставка: пустой блок — не тариф. */
function hasRates(pricing: Pricing | null | undefined): pricing is Pricing {
  if (!pricing) return false
  const rates = [pricing.input, pricing.output, pricing.cacheRead, pricing.cacheWrite]
  if (rates.some((rate) => typeof rate === 'number' && rate > 0)) return true
  return Object.values(pricing.agents ?? {}).some((tariff) =>
    [tariff.input, tariff.output, tariff.cacheRead, tariff.cacheWrite].some(
      (rate) => typeof rate === 'number' && rate > 0,
    ),
  )
}

/**
 * Цена по тарифу: ставки заданы за миллион токенов, чтение и запись считаются
 * отдельно. Кеш берётся только если ставка задана — иначе он бесплатный, а не
 * посчитанный по чужой цене.
 */
function priceOf(
  tariff: Pricing,
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const perMillion =
    tokens.input * (tariff.input ?? 0) +
    tokens.output * (tariff.output ?? 0) +
    tokens.cacheRead * (tariff.cacheRead ?? 0) +
    tokens.cacheWrite * (tariff.cacheWrite ?? 0)
  return perMillion / 1e6
}

/** Месячный лимит: из конфига, а без него — общий 60. */
function budgetOf(pricing: Pricing | null | undefined): number {
  const budget = pricing?.budget
  return typeof budget === 'number' && Number.isFinite(budget) && budget > 0 ? budget : DEFAULT_BUDGET
}

/**
 * Тариф и лимит живут в конфиге проекта. Замер читает их сам: путь к базе
 * инжектируется (в тестах временная SQLite), а тариф — свойство проекта, а не
 * обёртки CLI. Нет конфига — нет тарифа, и это честно говорится в отчёте.
 */
function pricingOf(root: string): Pricing | null {
  const path = join(root, '.toolbox-al', 'config.json')
  if (!existsSync(path)) return null
  return (readConfig(path) as Config & { pricing?: Pricing }).pricing ?? null
}

const percentOf = (amount: number, budget: number): number =>
  Math.round((amount / budget) * 1000) / 10

const unavailable = (dbPath: string, reason: string): ProfileUnavailable => ({
  available: false,
  dbPath,
  reason: `учёт недоступен: ${reason}`,
})

/**
 * Статистика по агентам в окне замера: только сессии, у которых
 * time_updated >= начала, иначе вчерашняя работа попала бы в сегодняшний замер.
 *
 * time_busy/time_idle в базе OpenCode — метки последних переходов, а не
 * накопленные длительности. Поэтому работа — последний интервал занятости
 * (от time_busy до time_idle, а если простой ещё не наступил — до
 * time_updated), простой — от time_idle до конца окна.
 */
function readWindow(
  dbPath: string,
  window: { since: number; until: number; pricing?: Pricing | null | undefined },
): ProfileWindow {
  if (!existsSync(dbPath)) return unavailable(dbPath, `база OpenCode не найдена — ${dbPath}`)

  let db: DatabaseSync
  try {
    // read-only: чужую базу смотрим, но не меняем
    db = new DatabaseSync(dbPath, { readOnly: true })
  } catch (error) {
    return unavailable(dbPath, `база OpenCode не открылась — ${(error as Error).message}`)
  }

  try {
    if (!hasTable(db, 'session_v2')) {
      return unavailable(dbPath, `в базе нет таблицы session_v2 — ${dbPath}`)
    }

    const columns = columnsOf(db, 'session_v2')
    if (!columns.has('time_updated')) {
      return unavailable(dbPath, `в session_v2 нет time_updated: окно замера не определить — ${dbPath}`)
    }

    const value = (name: string): string => (columns.has(name) ? `coalesce(${name}, 0)` : '0')
    const mark = (name: string): string => (columns.has(name) ? name : 'null')
    const agent = columns.has('agent')
      ? "coalesce(nullif(trim(agent), ''), 'без агента')"
      : "'без агента'"

    const sql =
      `select ${agent} as agent, ` +
      `${value('tokens_input')} as input, ` +
      `${value('tokens_output')} as output, ` +
      `${value('tokens_cache_read')} as cacheRead, ` +
      `${value('tokens_cache_write')} as cacheWrite, ` +
      `${value('cost')} as cost, ` +
      `${mark('time_created')} as created, ` +
      'time_updated as updated, ' +
      `${mark('time_busy')} as busy, ` +
      `${mark('time_idle')} as idle ` +
      'from session_v2 where time_updated >= ? order by time_updated, id'

    let rows: SessionRow[]
    try {
      rows = db.prepare(sql).all(window.since) as unknown as SessionRow[]
    } catch (error) {
      return unavailable(dbPath, `таблица session_v2 не читается — ${(error as Error).message}`)
    }

    interface Acc {
      agent: string
      sessions: number
      busyMs: number
      idleMs: number
      sawBusy: boolean
      sawIdle: boolean
      input: number
      output: number
      cacheRead: number
      cacheWrite: number
      cost: number
    }

    const byAgent = new Map<string, Acc>()

    for (const row of rows) {
      const acc =
        byAgent.get(row.agent) ??
        {
          agent: row.agent,
          sessions: 0,
          busyMs: 0,
          idleMs: 0,
          sawBusy: false,
          sawIdle: false,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          cost: 0,
        }

      acc.sessions += 1
      acc.input += row.input
      acc.output += row.output
      acc.cacheRead += row.cacheRead
      acc.cacheWrite += row.cacheWrite
      acc.cost += row.cost

      const busy = num(row.busy)
      const idle = num(row.idle)
      const updated = num(row.updated) ?? window.until

      // последнее состояние сессии: занята — работаем до последнего обновления,
      // простаивает — работа закончилась на time_idle
      const stillBusy = busy !== null && (idle === null || busy > idle)
      if (busy !== null) {
        acc.busyMs += overlap(busy, stillBusy ? updated : (idle ?? updated), window.since, window.until)
        acc.sawBusy = true
      }
      if (idle !== null && !stillBusy) {
        acc.idleMs += overlap(idle, window.until, window.since, window.until)
        acc.sawIdle = true
      }

      byAgent.set(row.agent, acc)
    }

    const budget = budgetOf(window.pricing)
    const rates = hasRates(window.pricing) ? window.pricing : null

    const agents: AgentProfile[] = [...byAgent.values()]
      .map((acc) => {
        // агент может переопределить ставки проекта — как в учёте токенов
        const override = rates?.agents?.[acc.agent]
        const tariff = override ? { ...rates, ...override } : rates
        const fromBase = acc.cost > 0 ? acc.cost : null
        const amount = fromBase ?? (tariff ? priceOf(tariff, acc) : null)

        return {
          agent: acc.agent,
          sessions: acc.sessions,
          busyMs: acc.sawBusy ? acc.busyMs : null,
          idleMs: acc.sawIdle ? acc.idleMs : null,
          input: acc.input,
          output: acc.output,
          cacheRead: acc.cacheRead,
          cacheWrite: acc.cacheWrite,
          tokens: acc.input + acc.output + acc.cacheRead + acc.cacheWrite,
          cost: acc.cost,
          amount,
          percent: amount === null ? null : percentOf(amount, budget),
          basis: fromBase !== null ? 'cost' : amount !== null ? 'tariff' : 'none',
        }
      })
      .sort((a, b) => b.tokens - a.tokens || a.agent.localeCompare(b.agent))

    const amount = agents.reduce<number | null>(
      (sum, agent) => (agent.amount === null ? sum : (sum ?? 0) + agent.amount),
      null,
    )

    const totals = agents.reduce<ProfileTotals>(
      (sum, agent) => ({
        sessions: sum.sessions + agent.sessions,
        busyMs: agent.busyMs === null ? sum.busyMs : (sum.busyMs ?? 0) + agent.busyMs,
        idleMs: agent.idleMs === null ? sum.idleMs : (sum.idleMs ?? 0) + agent.idleMs,
        input: sum.input + agent.input,
        output: sum.output + agent.output,
        cacheRead: sum.cacheRead + agent.cacheRead,
        cacheWrite: sum.cacheWrite + agent.cacheWrite,
        tokens: sum.tokens + agent.tokens,
        cost: sum.cost + agent.cost,
        amount: null,
        percent: null,
      }),
      {
        sessions: 0,
        busyMs: null,
        idleMs: null,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 0,
        cost: 0,
        amount: null,
        percent: null,
      },
    )
    totals.amount = amount
    totals.percent = amount === null ? null : percentOf(amount, budget)

    // цена из базы сильнее тарифа: это настоящие деньги, а не оценка
    const basis: PriceBasis = agents.some((agent) => agent.basis === 'tariff')
      ? 'tariff'
      : agents.some((agent) => agent.basis === 'cost')
        ? 'cost'
        : 'none'

    const notes: string[] = []
    if (!columns.has('time_busy') || !columns.has('time_idle')) {
      notes.push('время работы и простой недоступны: в базе нет time_busy/time_idle')
    } else if (agents.length > 0 && agents.every((agent) => agent.busyMs === null && agent.idleMs === null)) {
      notes.push('время работы и простой неизвестны: у сессий нет отметок занятости')
    }

    if (basis === 'none' && agents.length > 0) {
      notes.push('тариф не задан: цена не посчитана')
    } else if (agents.some((agent) => agent.basis === 'none')) {
      notes.push('у части агентов тариф не задан: их цена не посчитана')
    }

    return {
      available: true,
      dbPath,
      budget,
      basis,
      agents,
      totals,
      note: notes.length > 0 ? notes.join('; ') : null,
    }
  } finally {
    db.close()
  }
}

/**
 * Закрыть последний маркер и посчитать окно от его начала до сейчас.
 * Маркер закрывается, даже если базы нет: иначе «учёт недоступен» оставил бы
 * замер открытым навсегда. Путь к базе инжектируется — в тестах временная SQLite.
 */
export function endProfile(options: EndOptions): ProfileEnd {
  const now = options.now ?? new Date()
  const last = lastProfile(options.root)
  if (!last) throw new UserError(1, 'замеров нет: сначала profiler start')

  if (last.endedAt !== null) {
    throw new UserError(
      1,
      `замер «${last.label}» уже закрыт ${stamp(last.endedAt)}: второй profiler end не нужен`,
    )
  }

  const startedAt = Date.parse(last.startedAt)
  const marker: StoredMarker = { ...last, endedAt: now.toISOString() }
  const written: ProfileMarker = {
    label: marker.label,
    startedAt: marker.startedAt,
    endedAt: marker.endedAt,
    run: marker.run,
    executors: marker.executors,
  }
  writeMarker(marker.path, written)

  const durationMs = Math.max(0, now.getTime() - (Number.isNaN(startedAt) ? now.getTime() : startedAt))
  const pricing = options.pricing === undefined ? pricingOf(options.root) : options.pricing
  const window = readWindow(options.dbPath ?? opencodeDbPath(), {
    since: Number.isNaN(startedAt) ? now.getTime() : startedAt,
    until: now.getTime(),
    pricing,
  })

  return { marker, durationMs, ...window }
}

/** Текст таблицы замера: цифры по агенту, итог и оговорка про природу времени. */
export function renderProfile(end: ProfileEnd): string {
  const { marker } = end
  const run = marker.run ? ` · прогон ${marker.run}` : ''
  const head = `${marker.label}${run} · ${stamp(marker.startedAt)} → ${stamp(marker.endedAt ?? marker.startedAt)} · ${durationText(end.durationMs)}`

  if (!end.available) return [head, `база: ${end.dbPath}`, end.reason].join('\n')

  const lines = [head, `база: ${end.dbPath}`]

  if (end.agents.length === 0) {
    lines.push('в окне замера сессий нет: считать нечего')
    return lines.join('\n')
  }

  const header = ['агент', 'сессий', 'работа', 'простой', 'вход', 'выход', 'кеш', 'цена', '%']
  const rows = end.agents.map((agent) => [
    agent.agent,
    String(agent.sessions),
    durationText(agent.busyMs),
    durationText(agent.idleMs),
    numText(agent.input),
    numText(agent.output),
    numText(agent.cacheRead + agent.cacheWrite),
    moneyText(agent.amount),
    percentText(agent.percent),
  ])

  rows.push([
    'итого',
    String(end.totals.sessions),
    durationText(end.totals.busyMs),
    durationText(end.totals.idleMs),
    numText(end.totals.input),
    numText(end.totals.output),
    numText(end.totals.cacheRead + end.totals.cacheWrite),
    moneyText(end.totals.amount),
    percentText(end.totals.percent),
  ])

  // ширины считаем по содержимому: цифры не должны разъезжаться на длинных числах
  const widths = header.map((title, index) =>
    Math.max(title.length, ...rows.map((row) => row[index]?.length ?? 0)),
  )
  const render = (row: string[]) =>
    row
      .map((cell, index) => (index === 0 ? cell.padEnd(widths[index]!) : cell.padStart(widths[index]!)))
      .join('  ')

  lines.push(render(header), ...rows.map(render))

  // «тариф не задан» живёт в note: строка про basis молчала бы о цене
  if (end.basis === 'cost') {
    lines.push(`цена: cost из базы · процент от лимита ${moneyText(end.budget)}`)
  } else if (end.basis === 'tariff') {
    lines.push(`цена: тариф из конфига за 1 млн токенов · процент от лимита ${moneyText(end.budget)}`)
  }

  lines.push('работа и простой — последний интервал занятости сессий в окне (time_busy/time_idle), не история')
  if (end.note) lines.push(end.note)

  return lines.join('\n')
}

function durationText(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)} с`
  const minutes = Math.round(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return hours > 0 ? `${hours} ч ${pad(rest)} мин` : `${rest} мин`
}

function numText(value: number): string {
  return Math.round(value).toLocaleString('ru-RU').replace(/\u00A0/g, ' ')
}

const moneyText = (value: number | null): string => (value === null ? '—' : value.toFixed(2))

/** «7.1%»; null — цена не посчитана, а не ноль. */
function percentText(value: number | null): string {
  if (value === null) return '—'
  return `${Number(value.toFixed(1))}%`
}
