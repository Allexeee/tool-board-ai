import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const bin = resolve('bin/toolbox-al.ts')

function runCli(dir: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

interface SessionRow {
  agent: string
  input?: number
  directory?: string | null
  createdAt?: number
  updatedAt?: number
}

const SCHEMA = `
  create table session_v2 (
    id text primary key,
    directory text,
    agent text,
    tokens_input integer,
    tokens_output integer,
    tokens_reasoning integer,
    tokens_cache_read integer,
    tokens_cache_write integer,
    cost real,
    time_created integer,
    time_updated integer
  )
`

/** База OpenCode по пути: настоящую не трогаем, в тесте она своя. */
function writeDb(path: string, rows: SessionRow[], schema = SCHEMA): void {
  const db = new DatabaseSync(path)
  try {
    db.exec(schema)
    const insert = db.prepare(
      `insert into session_v2 (id, directory, agent, tokens_input, time_created, time_updated)
       values (?, ?, ?, ?, ?, ?)`,
    )
    rows.forEach((row, index) => {
      insert.run(
        `ses_${index}`,
        row.directory ?? null,
        row.agent,
        row.input ?? 0,
        row.createdAt ?? 0,
        row.updatedAt ?? 0,
      )
    })
  } finally {
    db.close()
  }
}

/** Каталог данных пользователя с базой OpenCode: путь подменяется через XDG_DATA_HOME. */
function dataHome(rows: SessionRow[], schema?: string): string {
  const data = mkdtempSync(join(tmpdir(), 'tbal-usage-cli-data-'))
  mkdirSync(join(data, 'opencode'), { recursive: true })
  writeDb(join(data, 'opencode', 'opencode.db'), rows, schema)
  return data
}

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tbal-usage-cli-'))
  const init = runCli(dir, ['init'])
  assert.equal(init.code, 0, init.err)
  return dir
}

test('run usage предупреждает, что расход включает историю сессии, начатой раньше', () => {
  const dir = project()
  const started = runCli(dir, ['run', 'start', '--mode', 'all'])
  assert.equal(started.code, 0, started.err || started.out)

  const now = Date.now()
  const data = dataHome([
    // сессия начата за час до прогона, но обновлена в нём — входит целиком
    {
      agent: 'worker-1',
      input: 100,
      directory: dir,
      createdAt: now - 3_600_000,
      updatedAt: now + 60_000,
    },
  ])

  const shown = runCli(dir, ['run', 'usage'], { XDG_DATA_HOME: data })
  assert.equal(shown.code, 0, shown.err || shown.out)
  assert.match(shown.out, /расход включает историю/)
  assert.match(shown.out, /накопительные/)
})

test('run usage без начатых раньше сессий про историю молчит', () => {
  const dir = project()
  const started = runCli(dir, ['run', 'start', '--mode', 'all'])
  assert.equal(started.code, 0, started.err || started.out)

  const now = Date.now()
  const data = dataHome([
    { agent: 'worker-1', input: 100, directory: dir, createdAt: now + 30_000, updatedAt: now + 60_000 },
  ])

  const shown = runCli(dir, ['run', 'usage'], { XDG_DATA_HOME: data })
  assert.equal(shown.code, 0, shown.err || shown.out)
  assert.doesNotMatch(shown.out, /расход включает историю/)
})

test('run usage на базе без tokens_reasoning печатает цифры, а не «учёт недоступен»', () => {
  const dir = project()
  const data = dataHome(
    [{ agent: 'worker-1', input: 100, directory: dir, createdAt: 1_000, updatedAt: 2_000 }],
    // старая база OpenCode: колонки reasoning ещё нет
    `
      create table session_v2 (
        id text primary key,
        directory text,
        agent text,
        tokens_input integer,
        tokens_output integer,
        cost real,
        time_created integer,
        time_updated integer
      )
    `,
  )

  const shown = runCli(dir, ['run', 'usage'], { XDG_DATA_HOME: data })
  assert.equal(shown.code, 0, shown.err || shown.out)
  assert.doesNotMatch(shown.out, /учёт недоступен/)
  assert.match(shown.out, /worker-1/)
  assert.match(shown.out, /100/)
})
