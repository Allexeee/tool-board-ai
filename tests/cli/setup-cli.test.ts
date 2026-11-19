import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeBoard } from '../helpers/board.ts'

const bin = resolve('bin/board.ts')

interface Result {
  code: number | null
  out: string
  err: string
}

function run(dir: string, args: string[]): Result {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function json(dir: string, args: string[]): Record<string, unknown> {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out) as Record<string, unknown>
}

test('setup: по умолчанию ревью выключено, состояние читается через --show', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const shown = json(fixture.root, ['setup', '--show'])
  assert.equal(shown.reviewAfterRun, false)
  assert.equal(shown.setupAt, null)
})

test('setup: включает и выключает ревью после забега', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const on = json(fixture.root, ['setup', '--review-after-run'])
  assert.equal(on.reviewAfterRun, true)
  assert.match(String(on.setupAt), /^\d{4}-\d{2}-\d{2}T/)

  const shown = json(fixture.root, ['setup', '--show'])
  assert.equal(shown.reviewAfterRun, true)

  const off = json(fixture.root, ['setup', '--no-review-after-run'])
  assert.equal(off.reviewAfterRun, false)
})

test('setup: взаимоисключающие флаги — код 3', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const both = run(fixture.root, ['setup', '--review-after-run', '--no-review-after-run'])
  assert.equal(both.code, 3)
  assert.match(both.err, /только один флаг/)

  const showAndToggle = run(fixture.root, ['setup', '--show', '--review-after-run'])
  assert.equal(showAndToggle.code, 3)
  assert.match(showAndToggle.err, /--show/)
})

test('setup без TTY не спрашивает и подсказывает терминал', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const result = run(fixture.root, ['setup'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /Запустите в терминале: board setup/)
})

test('init --json создаёт настройки, setup.md и не запускает мастер', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-init-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = run(root, ['init', '--json'])
  assert.equal(result.code, 0, result.err)

  const data = JSON.parse(result.out) as {
    created: string[]
    settings: { reviewAfterRun: boolean; setupAt: string | null }
  }
  assert.ok(data.created.includes('.board/settings.json'))
  assert.equal(data.settings.reviewAfterRun, false)
  assert.equal(data.settings.setupAt, null)
  assert.ok(existsSync(join(root, '.opencode', 'command', 'setup.md')))
})
