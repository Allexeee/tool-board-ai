import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { startRun } from '../../src/core/runs.ts'
import { endProfile, listProfiles, renderProfile, startProfile } from '../../src/core/profiler.ts'

/**
 * Настоящую базу OpenCode тест не трогает: путь всегда подменяется временной
 * SQLite с колонками session_v2, которые читает профайлер.
 */

const SCHEMA = `
  create table session_v2 (
    id text primary key,
    agent text,
    tokens_input integer,
    tokens_output integer,
    tokens_cache_read integer,
    tokens_cache_write integer,
    cost real,
    time_created integer,
    time_updated integer,
    time_busy integer,
    time_idle integer
  )
`

interface SessionRow {
  agent: string | null
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  cost?: number
  created: number
  updated: number
  busy?: number | null
  idle?: number | null
}

function makeOpencodeDb(rows: SessionRow[], options: { schema?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'tbal-profiler-db-'))
  const path = join(dir, 'opencode.db')
  const db = new DatabaseSync(path)
  try {
    db.exec(options.schema ?? SCHEMA)
    if (!options.schema) {
      const insert = db.prepare(
        `insert into session_v2
           (id, agent, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost,
            time_created, time_updated, time_busy, time_idle)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      rows.forEach((row, index) => {
        insert.run(
          `ses_${index}`,
          row.agent,
          row.input ?? 0,
          row.output ?? 0,
          row.cacheRead ?? 0,
          row.cacheWrite ?? 0,
          row.cost ?? 0,
          row.created,
          row.updated,
          row.busy ?? null,
          row.idle ?? null,
        )
      })
    }
  } finally {
    db.close()
  }
  return path
}

/** Каталог замера: маркеры пишутся в него, а не в трекер. */
function makeRoot(): string {
  return mkdtempSync(join(tmpdir(), 'tbal-profiler-root-'))
}

function projectDb() {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'worker-1', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'worker-2', kind: 'agent', skills: ['backend'], model: 'opencode-go/deepseek' })
  return db
}

const START = Date.parse('2026-11-18T09:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()

test('start пишет маркер с меткой, прогоном и составом исполнителей', () => {
  const root = makeRoot()
  const db = projectDb()
  startRun(db, { mode: 'all', now: new Date(START - 60_000) })

  const marker = startProfile(db, { root, label: '2 агента', now: new Date(START) })

  assert.equal(marker.label, '2 агента')
  assert.equal(marker.startedAt, iso(START))
  assert.equal(marker.endedAt, null)
  assert.equal(marker.run, 'RUN1')
  assert.deepEqual(
    marker.executors.map((executor) => executor.id),
    ['worker-1', 'worker-2'],
  )
  assert.equal(marker.executors[1]!.model, 'opencode-go/deepseek')

  // маркер — файл: его читает end и по нему же видно, что замер идёт
  assert.equal(existsSync(marker.path), true)
  assert.match(basename(marker.path), /^profiler-\d{8}-\d{6}-\d{3}\.json$/)

  const stored = JSON.parse(readFileSync(marker.path, 'utf8')) as {
    label: string
    run: string | null
    endedAt: string | null
    executors: unknown[]
    startedAt: string
  }
  assert.equal(stored.label, '2 агента')
  assert.equal(stored.startedAt, iso(START))
  assert.equal(stored.run, 'RUN1')
  assert.equal(stored.endedAt, null)
  assert.equal(stored.executors.length, 2)

  // второй старт без конца закрыл бы не тот замер
  assert.throws(
    () => startProfile(db, { root, label: '3 агента', now: new Date(START + 1_000) }),
    (error: unknown) => (error as { code?: number }).code === 1,
  )
})

test('в окне замера — только сессии с time_updated после начала', () => {
  const db = projectDb()
  const root = makeRoot()

  startProfile(db, { root, label: '2 агента', now: new Date(START) })

  const dbPath = makeOpencodeDb([
    {
      agent: 'worker-1',
      input: 100,
      output: 20,
      cacheRead: 1_000,
      cacheWrite: 5,
      cost: 0.4,
      created: START - 3_600_000,
      updated: START + 300_000,
      busy: START + 60_000,
      idle: START + 240_000,
    },
    {
      agent: 'worker-2',
      input: 50,
      output: 10,
      cost: 0.1,
      created: START + 1_000,
      updated: START + 120_000,
      busy: START,
      idle: null,
    },
    // вчерашняя сессия: в окно не попадает, иначе замер сравнивал бы не то
    {
      agent: 'build',
      input: 9_999,
      output: 9_999,
      created: START - 7_200_000,
      updated: START - 60_000,
      busy: START - 3_600_000,
      idle: START - 120_000,
    },
  ])

  const end = endProfile({ root, dbPath, now: new Date(START + 600_000) })

  assert.equal(end.available, true)
  if (!end.available) return

  assert.equal(end.durationMs, 600_000)
  assert.deepEqual(
    end.agents.map((agent) => agent.agent),
    ['worker-1', 'worker-2'],
    'build работал до замера и в таблицу не попадает',
  )

  const worker1 = end.agents[0]!
  assert.equal(worker1.sessions, 1)
  assert.equal(worker1.busyMs, 180_000, 'занят с time_busy до time_idle')
  assert.equal(worker1.idleMs, 360_000, 'простой с time_idle до конца окна')
  assert.equal(worker1.input, 100)
  assert.equal(worker1.output, 20)
  assert.equal(worker1.cacheRead, 1_000)
  assert.equal(worker1.cacheWrite, 5)
  assert.equal(worker1.tokens, 1_125)
  assert.equal(worker1.cost, 0.4)

  const worker2 = end.agents[1]!
  assert.equal(worker2.busyMs, 120_000, 'простой не наступил: работа до последнего обновления')
  assert.equal(worker2.idleMs, null, 'нет отметки простоя — не ноль, а «неизвестно»')
  assert.equal(worker2.cost, 0.1)

  assert.equal(end.totals.sessions, 2)
  assert.equal(end.totals.busyMs, 300_000)
  assert.equal(end.totals.idleMs, 360_000)
  assert.equal(end.totals.tokens, 1_185)
  assert.equal(end.totals.cost, 0.5)

  // маркер закрыт тем же концом, что и таблица
  assert.equal(end.marker.endedAt, iso(START + 600_000))
  const stored = JSON.parse(readFileSync(end.marker.path, 'utf8')) as { endedAt: string | null }
  assert.equal(stored.endedAt, iso(START + 600_000))

  const table = renderProfile(end)
  assert.match(table, /worker-1/)
  assert.match(table, /итого/)
})

test('нет базы OpenCode: «учёт недоступен», а маркер всё равно закрыт', () => {
  const db = projectDb()
  const root = makeRoot()
  startProfile(db, { root, label: 'без базы', now: new Date(START) })

  const missing = join(tmpdir(), `tbal-profiler-missing-${process.pid}-${Date.now()}`, 'opencode.db')
  const end = endProfile({ root, dbPath: missing, now: new Date(START + 60_000) })

  assert.equal(end.available, false)
  if (end.available) return
  assert.match(end.reason, /учёт недоступен/)
  assert.match(end.reason, /не найдена/)
  assert.equal('agents' in end, false, 'пустой таблицы с нулями нет')
  assert.equal(end.marker.endedAt, iso(START + 60_000))

  assert.match(renderProfile(end), /учёт недоступен/)
})

test('без time_busy/time_idle токены считаются, время — «неизвестно», а не ноль', () => {
  const db = projectDb()
  const root = makeRoot()
  startProfile(db, { root, label: 'старая база', now: new Date(START) })

  const dbPath = makeOpencodeDb([], {
    schema: `
      create table session_v2 (
        id text primary key,
        agent text,
        tokens_input integer,
        tokens_output integer,
        cost real,
        time_created integer,
        time_updated integer
      )
    `,
  })

  const writer = new DatabaseSync(dbPath)
  try {
    writer
      .prepare('insert into session_v2 (id, agent, tokens_input, tokens_output, cost, time_created, time_updated) values (?, ?, ?, ?, ?, ?, ?)')
      .run('ses_1', 'worker-1', 100, 50, 0.5, START, START + 60_000)
  } finally {
    writer.close()
  }

  const end = endProfile({ root, dbPath, now: new Date(START + 120_000) })
  assert.equal(end.available, true)
  if (!end.available) return

  assert.equal(end.agents[0]!.input, 100)
  assert.equal(end.agents[0]!.tokens, 150)
  assert.equal(end.agents[0]!.busyMs, null)
  assert.equal(end.agents[0]!.idleMs, null)
  assert.match(end.note ?? '', /time_busy\/time_idle/)
})

test('end без старта и повторный end — отказ, а не тихая запись', () => {
  const db = projectDb()
  const root = makeRoot()

  assert.throws(
    () => endProfile({ root, dbPath: join(root, 'нет.db') }),
    (error: unknown) => (error as { code?: number }).code === 1,
  )

  startProfile(db, { root, label: 'один', now: new Date(START) })
  endProfile({ root, dbPath: join(root, 'нет.db'), now: new Date(START + 1_000) })

  assert.throws(
    () => endProfile({ root, dbPath: join(root, 'нет.db'), now: new Date(START + 2_000) }),
    (error: unknown) => (error as { code?: number }).code === 1,
  )

  assert.equal(listProfiles(root).length, 1)
})

test('новый замер после закрытого — новый маркер, а не перезапись', () => {
  const db = projectDb()
  const root = makeRoot()

  startProfile(db, { root, label: '1 агент', now: new Date(START) })
  endProfile({ root, dbPath: join(root, 'нет.db'), now: new Date(START + 60_000) })
  const second = startProfile(db, { root, label: '3 агента', now: new Date(START + 120_000) })

  const markers = listProfiles(root)
  assert.equal(markers.length, 2)
  assert.deepEqual(
    markers.map((marker) => marker.label),
    ['1 агент', '3 агента'],
  )
  assert.equal(markers[1]!.path, second.path)

  const files = readdirSync(join(root, '.toolbox-al', 'reports')).filter((name) =>
    name.endsWith('.json'),
  )
  assert.equal(files.length, 2)
})

/** Одна сессия в окне: цена и процент считаются от её токенов. */
function oneSession(
  root: string,
  rows: Parameters<typeof makeOpencodeDb>[0],
  pricing: Parameters<typeof endProfile>[0]['pricing'],
) {
  const db = projectDb()
  startProfile(db, { root, label: 'цена', now: new Date(START) })
  const dbPath = makeOpencodeDb(rows)
  return endProfile({ root, dbPath, pricing, now: new Date(START + 60_000) })
}

test('тариф задан: чтение и запись отдельно, процент от лимита из конфига', () => {
  const end = oneSession(
    makeRoot(),
    [
      {
        agent: 'worker-1',
        input: 1_000_000,
        output: 1_000_000,
        cacheRead: 500_000,
        created: START,
        updated: START + 1_000,
      },
    ],
    { input: 1, output: 3, cacheRead: 0.5, budget: 60 },
  )

  assert.equal(end.available, true)
  if (!end.available) return

  const agent = end.agents[0]!
  // 1 млн чтения по 1 + 1 млн записи по 3 + 0.5 млн кеша по 0.5
  assert.equal(agent.amount, 4.25)
  assert.equal(agent.percent, 7.1)
  assert.equal(agent.basis, 'tariff')
  assert.equal(end.basis, 'tariff')
  assert.equal(end.budget, 60)
  assert.equal(end.totals.amount, 4.25)
  assert.equal(end.totals.percent, 7.1)
  assert.match(renderProfile(end), /тариф из конфига/)
  assert.match(renderProfile(end), /7\.1%/)
})

test('cost в базе больше нуля: берём его, тариф не пересчитывает', () => {
  const end = oneSession(
    makeRoot(),
    [
      {
        agent: 'worker-1',
        input: 1_000_000,
        output: 1_000_000,
        cost: 5,
        created: START,
        updated: START + 1_000,
      },
    ],
    { input: 100, output: 100, budget: 60 },
  )

  assert.equal(end.available, true)
  if (!end.available) return

  assert.equal(end.agents[0]!.amount, 5)
  assert.equal(end.agents[0]!.percent, 8.3)
  assert.equal(end.agents[0]!.basis, 'cost')
  assert.equal(end.basis, 'cost')
  assert.match(renderProfile(end), /cost из базы/)
})

test('без тарифа и без cost — «тариф не задан», а не нули', () => {
  const end = oneSession(
    makeRoot(),
    [{ agent: 'worker-1', input: 100, output: 50, created: START, updated: START + 1_000 }],
    // пустой блок pricing — не тариф: нули вместо цены недопустимы
    {},
  )

  assert.equal(end.available, true)
  if (!end.available) return

  assert.equal(end.agents[0]!.amount, null)
  assert.equal(end.agents[0]!.percent, null)
  assert.equal(end.agents[0]!.basis, 'none')
  assert.equal(end.basis, 'none')
  assert.match(end.note ?? '', /тариф не задан/)

  const table = renderProfile(end)
  assert.match(table, /—/)
  assert.match(table, /тариф не задан/)
  assert.doesNotMatch(table, /0\.00/)
})

test('бюджета в конфиге нет — лимит 60 по умолчанию', () => {
  const end = oneSession(
    makeRoot(),
    [{ agent: 'worker-1', input: 600_000, created: START, updated: START + 1_000 }],
    { input: 1, output: 1 },
  )

  assert.equal(end.available, true)
  if (!end.available) return

  assert.equal(end.budget, 60)
  assert.equal(end.agents[0]!.amount, 0.6)
  assert.equal(end.agents[0]!.percent, 1)
})

test('тариф и лимит читаются из конфига проекта, если не переданы явно', () => {
  const db = projectDb()
  const root = makeRoot()
  mkdirSync(join(root, '.toolbox-al'), { recursive: true })
  writeFileSync(
    join(root, '.toolbox-al', 'config.json'),
    JSON.stringify({ pricing: { input: 2, output: 1, budget: 30 } }),
    'utf8',
  )

  startProfile(db, { root, label: 'из конфига', now: new Date(START) })
  const dbPath = makeOpencodeDb([
    { agent: 'worker-1', input: 3_000_000, output: 3_000_000, created: START, updated: START + 1_000 },
  ])

  const end = endProfile({ root, dbPath, now: new Date(START + 60_000) })
  assert.equal(end.available, true)
  if (!end.available) return

  // 3 млн чтения по 2 + 3 млн записи по 1 = 9 из лимита 30
  assert.equal(end.budget, 30)
  assert.equal(end.agents[0]!.amount, 9)
  assert.equal(end.agents[0]!.percent, 30)
})
