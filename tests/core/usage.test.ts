import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { opencodeDbPath, readUsage } from '../../src/core/usage.ts'

/**
 * Настоящую базу OpenCode тест не трогает: путь всегда подменяется временной SQLite,
 * у которой есть только колонки, нужные учёту.
 */

interface SessionRow {
  agent: string | null
  input?: number
  output?: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
}

const SCHEMA = `
  create table session_v2 (
    id text primary key,
    agent text,
    model text,
    tokens_input integer,
    tokens_output integer,
    tokens_reasoning integer,
    tokens_cache_read integer,
    tokens_cache_write integer,
    cost real,
    parent_id text,
    title text,
    time_updated integer
  )
`

function makeDb(rows: SessionRow[], options: { schema?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tbal-usage-'))
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(options.schema ?? SCHEMA)
    if (!options.schema) {
      const insert = db.prepare(
        `insert into session_v2
           (id, agent, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write, cost)
         values (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      rows.forEach((row, index) => {
        insert.run(
          `ses_${index}`,
          row.agent,
          row.input ?? 0,
          row.output ?? 0,
          row.reasoning ?? 0,
          row.cacheRead ?? 0,
          row.cacheWrite ?? 0,
          row.cost ?? 0,
        )
      })
    }
  } finally {
    db.close()
  }
  return path
}

test('сессии группируются по агенту, токены складываются', () => {
  const dbPath = makeDb([
    { agent: 'worker-2', input: 100, output: 50, reasoning: 10, cacheRead: 1000 },
    { agent: 'worker-2', input: 20, output: 5 },
    { agent: 'build', input: 7, output: 3 },
  ])

  const usage = readUsage({ dbPath })
  assert.equal(usage.available, true)
  if (!usage.available) return

  assert.deepEqual(
    usage.agents.map((agent) => agent.agent),
    ['worker-2', 'build'],
    'сначала тот, кто сжёг больше токенов',
  )

  const worker = usage.agents[0]!
  assert.equal(worker.sessions, 2)
  assert.equal(worker.input, 120)
  assert.equal(worker.output, 55)
  assert.equal(worker.reasoning, 10)
  assert.equal(worker.cacheRead, 1000)
  assert.equal(worker.tokens, 1185)

  assert.equal(usage.totals.sessions, 3)
  assert.equal(usage.totals.tokens, 1195)
})

test('сессии без агента не теряются и не притворяются чужими', () => {
  const dbPath = makeDb([{ agent: null, input: 5 }, { agent: '  ', input: 1 }])

  const usage = readUsage({ dbPath })
  assert.equal(usage.available, true)
  if (!usage.available) return

  assert.deepEqual(usage.agents.map((agent) => agent.agent), ['без агента'])
  assert.equal(usage.agents[0]!.sessions, 2)
  assert.equal(usage.agents[0]!.input, 6)
})

test('cost больше нуля: процент считается от бюджета', () => {
  const dbPath = makeDb([
    { agent: 'worker-1', input: 10, cost: 30 },
    { agent: 'worker-2', input: 10, cost: 10 },
  ])

  const usage = readUsage({ dbPath, budget: 60 })
  assert.equal(usage.available, true)
  if (!usage.available) return

  const byAgent = new Map(usage.agents.map((agent) => [agent.agent, agent]))
  assert.equal(usage.basis, 'cost')
  assert.equal(usage.budget, 60)
  assert.equal(usage.totals.cost, 40)
  assert.equal(byAgent.get('worker-1')!.percent, 50)
  assert.equal(byAgent.get('worker-2')!.percent, 16.7)
})

test('cost = 0 (подписка): процент по тарифу из конфига', () => {
  const dbPath = makeDb([
    { agent: 'build', input: 1_000_000 },
    { agent: 'worker-2', input: 1_000_000, output: 1_000_000 },
  ])

  const usage = readUsage({ dbPath, pricing: { input: 1, output: 3 }, budget: 60 })
  assert.equal(usage.available, true)
  if (!usage.available) return

  const byAgent = new Map(usage.agents.map((agent) => [agent.agent, agent]))
  assert.equal(usage.basis, 'tariff')
  // 1 млн входа по 1 + 1 млн выхода по 3 = 4 условных единицы из лимита 60
  assert.equal(byAgent.get('worker-2')!.amount, 4)
  assert.equal(byAgent.get('worker-2')!.percent, 6.7)
  assert.equal(byAgent.get('build')!.amount, 1)
  assert.equal(byAgent.get('build')!.percent, 1.7)
})

test('тариф агента перекрывает общий тариф проекта, бюджет берётся из конфига', () => {
  const dbPath = makeDb([{ agent: 'worker-2', input: 1_000_000 }])

  const usage = readUsage({
    dbPath,
    pricing: { input: 1, output: 3, budget: 10, agents: { 'worker-2': { input: 2 } } },
  })
  assert.equal(usage.available, true)
  if (!usage.available) return

  assert.equal(usage.budget, 10, 'бюджет из pricing.budget')
  assert.equal(usage.agents[0]!.amount, 2, 'у агента свой тариф входа, а выход наследуется')
  assert.equal(usage.agents[0]!.percent, 20)
})

test('cost = 0 и тарифа нет: доля от общего расхода токенов с пометкой', () => {
  const dbPath = makeDb([
    { agent: 'worker-1', input: 75 },
    { agent: 'worker-2', input: 25 },
  ])

  const usage = readUsage({ dbPath })
  assert.equal(usage.available, true)
  if (!usage.available) return

  assert.equal(usage.basis, 'share')
  assert.equal(usage.budget, null)
  assert.match(usage.note ?? '', /тариф не задан/)
  const byAgent = new Map(usage.agents.map((agent) => [agent.agent, agent]))
  assert.equal(byAgent.get('worker-1')!.percent, 75)
  assert.equal(byAgent.get('worker-2')!.percent, 25)
})

test('пустой pricing — не тариф: проценты не превращаются в нули', () => {
  const dbPath = makeDb([{ agent: 'build', input: 10 }])

  const usage = readUsage({ dbPath, pricing: {}, budget: 60 })
  assert.equal(usage.available, true)
  if (!usage.available) return

  assert.equal(usage.basis, 'share')
  assert.equal(usage.agents[0]!.percent, 100)
  assert.match(usage.note ?? '', /тариф не задан/)
})

test('нет базы OpenCode: честное «учёт недоступен», а не нули', () => {
  const dbPath = join(tmpdir(), `tbal-usage-missing-${process.pid}-${Date.now()}`, 'opencode.db')

  const usage = readUsage({ dbPath })
  assert.equal(usage.available, false)
  if (usage.available) return

  assert.match(usage.reason, /учёт недоступен/)
  assert.match(usage.reason, /не найдена/)
  assert.equal('agents' in usage, false, 'пустого отчёта с нулями нет')
  assert.equal('totals' in usage, false)
})

test('база есть, а таблицы session_v2 нет: тоже «учёт недоступен»', () => {
  const dbPath = makeDb([], { schema: 'create table sessions (id text)' })

  const usage = readUsage({ dbPath })
  assert.equal(usage.available, false)
  if (usage.available) return

  assert.match(usage.reason, /нет таблицы session_v2/)
})

test('чтение не меняет чужую базу', () => {
  const dbPath = makeDb([{ agent: 'worker-2', input: 42, cost: 1 }])
  const before = (() => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return db.prepare('select count(*) as c, sum(tokens_input) as tokens from session_v2').get()
    } finally {
      db.close()
    }
  })()

  readUsage({ dbPath, budget: 100 })

  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const after = db.prepare('select count(*) as c, sum(tokens_input) as tokens from session_v2').get()
    assert.deepEqual(after, before)
  } finally {
    db.close()
  }
})

test('путь по умолчанию — данные пользователя, а не проект', () => {
  assert.equal(
    opencodeDbPath({ XDG_DATA_HOME: join('data') } as NodeJS.ProcessEnv),
    join('data', 'opencode', 'opencode.db'),
  )
})
