import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { seedCard } from '../helpers/board.ts'
import { makeRepo } from '../helpers/repo.ts'
import { openDb } from '../../src/core/db.ts'
import { DatabaseSync } from 'node:sqlite'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1' },
    windowsHide: true,
  })
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Запуск без проекта — для help/version/неизвестной команды. */
function runCli(args: string[]) {
  return run(tmpdir(), args)
}

const NEW_COMMANDS = [
  'init',
  'setup',
  'executor',
  'card',
  'queue',
  'run',
  'take',
  'finish',
  'block',
  'touch',
  'ask',
  'answer',
  'decision',
  'term',
  'command',
  'review',
  'release',
  'now',
  'doctor',
]

const OLD_COMMANDS = ['feature', 'stage', 'plan', 'routine']

test('help перечисляет новые команды и не упоминает старые', () => {
  const { status, stdout } = runCli(['--help'])
  assert.equal(status, 0)
  for (const command of NEW_COMMANDS) {
    assert.match(stdout, new RegExp(`\\b${command}\\b`), command)
  }
  for (const command of OLD_COMMANDS) {
    assert.doesNotMatch(stdout, new RegExp(command), command)
  }
})

test('help объясняет --json и коды выхода', () => {
  const { stdout } = runCli(['help'])
  assert.match(stdout, /--json/)
  assert.match(stdout, /0 — успех|0\s*—\s*успех/)
  assert.match(stdout, /3/)
})

test('неизвестная команда — код 3', () => {
  const { status, stderr } = runCli(['nope'])
  assert.equal(status, 3)
  assert.match(stderr, /неизвестная команда/)
})

test('--version печатает версию из package.json', () => {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string }
  const { status, stdout } = runCli(['--version'])
  assert.equal(status, 0)
  assert.equal(stdout.trim(), pkg.version)
})

test('doctor --json возвращает { errors, warnings }', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'board-doctor-json-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.equal(run(dir, ['init']).status, 0)

  // без git — ошибка «не репозиторий», код 3, но форма JSON остаётся.
  const result = run(dir, ['doctor', '--json'])
  assert.equal(result.status, 3)
  const data = JSON.parse(result.stdout) as { errors: string[]; warnings: string[] }
  assert.deepEqual(Object.keys(data).sort(), ['errors', 'warnings'])
  assert.ok(Array.isArray(data.errors))
  assert.ok(Array.isArray(data.warnings))
  assert.ok(data.errors.some((e) => /git|репозиторий/.test(e)), data.errors.join(' | '))
})

test('doctor: чистая доска — код 0', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  assert.equal(run(repo.root, ['init']).status, 0)

  const result = run(repo.root, ['doctor'])
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.match(result.stdout, /всё в порядке/)
})

test('doctor: предупреждение — код 1', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  assert.equal(run(repo.root, ['init']).status, 0)

  const db = openDb(join(repo.root, '.board', 'board.db'))
  seedCard(db, { phase: 'task', status: 'review' })
  db.close()

  const result = run(repo.root, ['doctor'])
  assert.equal(result.status, 1, result.stdout + result.stderr)
  assert.match(result.stdout, /ревью/)
})

function setSchemaVersion(dir: string, version: string): void {
  const db = new DatabaseSync(join(dir, '.board', 'board.db'))
  db.prepare("update meta set value = ? where key = 'schemaVersion'").run(version)
  db.close()
}

function readSchemaVersion(dir: string): string {
  const db = new DatabaseSync(join(dir, '.board', 'board.db'))
  const row = db.prepare("select value from meta where key = 'schemaVersion'").get() as
    | { value: string }
    | undefined
  db.close()
  return row?.value ?? '0'
}

test('doctor --json: устаревшая схема — { errors } и без авто-миграции', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  assert.equal(run(repo.root, ['init']).status, 0)
  setSchemaVersion(repo.root, '0')

  const result = run(repo.root, ['doctor', '--json'])
  assert.equal(result.status, 3, result.stdout + result.stderr)
  const data = JSON.parse(result.stdout) as { errors: string[]; warnings: string[] }
  assert.deepEqual(Object.keys(data).sort(), ['errors', 'warnings'])
  assert.ok(data.errors.some((e) => e.includes('схем')), data.errors.join(' | '))
  // doctor не мигрирует устаревшую схему
  assert.equal(readSchemaVersion(repo.root), '0')
})

test('doctor --json: новее схема — { errors }, без raw-ошибки на stderr', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  assert.equal(run(repo.root, ['init']).status, 0)
  setSchemaVersion(repo.root, '99')

  const result = run(repo.root, ['doctor', '--json'])
  assert.equal(result.status, 3, result.stdout + result.stderr)
  const data = JSON.parse(result.stdout) as { errors: string[]; warnings: string[] }
  assert.deepEqual(Object.keys(data).sort(), ['errors', 'warnings'])
  assert.ok(data.errors.some((e) => e.includes('схем')), data.errors.join(' | '))
  assert.equal(result.stderr, '')
})
