import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { makeBoard } from '../helpers/board.ts'

const bin = resolve('bin/board.ts')

interface Result {
  code: number | null
  out: string
  err: string
}

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Result {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function json(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Record<string, unknown> {
  const result = run(dir, [...args, '--json'], env)
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out) as Record<string, unknown>
}

test('setup: v2 defaults читаются через --show', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const shown = json(fixture.root, ['setup', '--show'])
  assert.deepEqual(shown.reviewer, { model: null })
  assert.deepEqual(shown.specReview, { mode: 'auto', largeSpecChars: 6000 })
  assert.deepEqual(shown.runReview, { mode: 'none' })
  assert.equal(shown.setupAt, null)
})

test('setup: все режимы обновляются флагами', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const updated = json(fixture.root, [
    'setup',
    '--spec-review', 'self',
    '--large-spec', '4000',
    '--run-review', 'subagent',
    '--reviewer-model', 'opencode-go/deepseek-v4.1-flash',
  ])
  assert.deepEqual(updated.reviewer, { model: 'opencode-go/deepseek-v4.1-flash' })
  assert.deepEqual(updated.specReview, { mode: 'self', largeSpecChars: 4000 })
  assert.deepEqual(updated.runReview, { mode: 'subagent' })
  assert.match(String(updated.setupAt), /^\d{4}-\d{2}-\d{2}T/)

  const shown = json(fixture.root, ['setup', '--show'])
  assert.deepEqual(shown.specReview, { mode: 'self', largeSpecChars: 4000 })
})

test('setup: показывает effective reviewer model из сессии', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const shown = json(fixture.root, ['setup', '--show'], {
    BOARD_SESSION_MODEL: 'acme/reviewer',
    BOARD_MODEL_VARIANT: 'max',
  })
  assert.equal(shown.effectiveReviewerModel, 'acme/reviewer')
})

test('setup: старые флаги остаются алиасами', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const on = json(fixture.root, ['setup', '--review-after-run'])
  assert.deepEqual(on.runReview, { mode: 'subagent' })
  const off = json(fixture.root, ['setup', '--no-review-after-run'])
  assert.deepEqual(off.runReview, { mode: 'none' })
})

test('setup: конфликтующие флаги — код 3', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  assert.equal(run(fixture.root, ['setup', '--review-after-run', '--no-review-after-run']).code, 3)
  assert.equal(run(fixture.root, ['setup', '--show', '--review-after-run']).code, 3)
  assert.equal(run(fixture.root, ['setup', '--run-review', 'subagent', '--review-after-run']).code, 3)
  assert.equal(run(fixture.root, ['setup', '--spec-review', 'sometimes']).code, 3)
  assert.equal(run(fixture.root, ['setup', '--reviewer-model', 'provider/model#max']).code, 3)
})

test('setup без TTY не спрашивает и подсказывает терминал', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const result = run(fixture.root, ['setup'])
  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /Запустите в терминале: board setup/)
})

test('init --json создаёт v2-настройки и просит запустить мастер', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-init-settings-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  const result = run(root, ['init', '--json'])
  assert.equal(result.code, 0, result.err)

  const data = JSON.parse(result.out) as {
    created: string[]
    updated: string[]
    setupRequired: boolean
    settings: {
      reviewer: { model: string | null }
      specReview: { mode: string; largeSpecChars: number }
      runReview: { mode: string }
      setupAt: string | null
    }
  }
  assert.ok(data.created.includes('.board/settings.json'))
  assert.deepEqual(data.updated, [])
  assert.equal(data.setupRequired, true)
  assert.deepEqual(data.settings.reviewer, { model: null })
  assert.deepEqual(data.settings.specReview, { mode: 'auto', largeSpecChars: 6000 })
  assert.deepEqual(data.settings.runReview, { mode: 'none' })
  assert.equal(data.settings.setupAt, null)
  assert.ok(existsSync(join(root, '.opencode', 'command', 'setup.md')))

  json(root, ['setup', '--run-review', 'subagent'])
  const again = JSON.parse(run(root, ['init', '--json']).out) as { setupRequired: boolean }
  assert.equal(again.setupRequired, false)
})

test('init --refresh обновляет старый плагин и скилл', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-init-refresh-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(run(root, ['init', '--json']).code, 0)
  const plugin = join(root, '.opencode', 'plugins', 'board', 'index.ts')
  const skill = join(root, '.opencode', 'skills', 'board', 'SKILL.md')
  writeFileSync(plugin, '// старый плагин\n', 'utf8')
  writeFileSync(skill, '# старый скилл\n', 'utf8')

  const result = run(root, ['init', '--refresh', '--json'])
  assert.equal(result.code, 0, result.err)
  const data = JSON.parse(result.out) as { updated: string[] }

  assert.ok(data.updated.some((path) => path.includes('plugins/board/index.ts')))
  assert.ok(data.updated.some((path) => path.includes('skills/board/SKILL.md')))
  assert.match(readFileSync(plugin, 'utf8'), /board_setup/)
  assert.match(readFileSync(skill, 'utf8'), /## Настройки/)
})
