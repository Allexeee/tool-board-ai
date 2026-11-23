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
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1', ...env },
    windowsHide: true,
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
  assert.deepEqual(shown.specReview, { mode: 'auto', maxSpecChars: 1500, largeSpecChars: 6000 })
  assert.deepEqual(shown.runReview, { mode: 'none' })
  assert.equal(shown.setupAt, null)
})

test('setup: все режимы обновляются флагами', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)

  const updated = json(fixture.root, [
    'setup',
    '--spec-review', 'self',
    '--max-spec', '2000',
    '--large-spec', '4000',
    '--run-review', 'subagent',
    '--reviewer-model', 'opencode-go/deepseek-v4.1-flash',
  ])
  assert.deepEqual(updated.reviewer, { model: 'opencode-go/deepseek-v4.1-flash' })
  assert.deepEqual(updated.specReview, { mode: 'self', maxSpecChars: 2000, largeSpecChars: 4000 })
  assert.deepEqual(updated.runReview, { mode: 'subagent' })
  assert.match(String(updated.setupAt), /^\d{4}-\d{2}-\d{2}T/)

  const shown = json(fixture.root, ['setup', '--show'])
  assert.deepEqual(shown.specReview, { mode: 'self', maxSpecChars: 2000, largeSpecChars: 4000 })
})

test('setup: создаёт и удаляет board-reviewer.md по модели', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  const agent = join(fixture.root, '.opencode', 'agents', 'board-reviewer.md')

  json(fixture.root, ['setup', '--reviewer-model', 'acme/reviewer'])
  assert.match(readFileSync(agent, 'utf8'), /model: acme\/reviewer/)
  assert.doesNotMatch(readFileSync(agent, 'utf8'), /#max|#high/)

  json(fixture.root, ['setup', '--reviewer-model', ''])
  assert.equal(existsSync(agent), false)
})

test('setup: создаёт board-reviewer.md из effective-модели сессии', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  const agent = join(fixture.root, '.opencode', 'agents', 'board-reviewer.md')

  run(fixture.root, ['setup', '--spec-review', 'self'], {
    BOARD_SESSION_MODEL: 'acme/main',
    BOARD_MODEL_VARIANT: 'max',
  })

  assert.match(readFileSync(agent, 'utf8'), /model: acme\/main/)
  assert.doesNotMatch(readFileSync(agent, 'utf8'), /#max|#high/)
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
  const home = mkdtempSync(join(tmpdir(), 'board-init-home-'))
  t.after(() => {
    rmSync(root, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  })
  const env = { HOME: home, USERPROFILE: home }

  const result = run(root, ['init', '--json'], env)
  assert.equal(result.code, 0, result.err)

  const data = JSON.parse(result.out) as {
    created: string[]
    updated: string[]
    setupRequired: boolean
    settings: {
      reviewer: { model: string | null }
      specReview: { mode: string; maxSpecChars: number; largeSpecChars: number }
      runReview: { mode: string }
      setupAt: string | null
    }
  }
  assert.ok(data.created.includes('.board/settings.json'))
  assert.deepEqual(data.updated, [])
  assert.equal(data.setupRequired, true)
  assert.deepEqual(data.settings.reviewer, { model: null })
  assert.deepEqual(data.settings.specReview, {
    mode: 'auto',
    maxSpecChars: 1500,
    largeSpecChars: 6000,
  })
  assert.deepEqual(data.settings.runReview, { mode: 'none' })
  assert.equal(data.settings.setupAt, null)
  assert.ok(existsSync(join(root, '.opencode', 'command', 'setup.md')))

  const recommendations = (data as unknown as { recommendations: string[] }).recommendations
  assert.ok(
    recommendations.some((item) => item.includes('superpowers')),
    recommendations.join(' | '),
  )

  writeFileSync(
    join(root, '.opencode', 'opencode.json'),
    JSON.stringify({ plugins: ['superpowers'] }),
    'utf8',
  )
  const withPlugin = JSON.parse(run(root, ['init', '--json'], env).out) as {
    recommendations: string[]
  }
  assert.deepEqual(withPlugin.recommendations, [])

  json(root, ['setup', '--run-review', 'subagent'])
  const again = JSON.parse(run(root, ['init', '--json'], env).out) as { setupRequired: boolean }
  assert.equal(again.setupRequired, false)
})

test('init --refresh обновляет старый плагин и навык', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'board-init-refresh-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))

  assert.equal(run(root, ['init', '--json']).code, 0)
  const plugin = join(root, '.opencode', 'plugins', 'board', 'index.ts')
  const skill = join(root, '.opencode', 'skills', 'board-spec', 'SKILL.md')
  writeFileSync(plugin, '// старый плагин\n', 'utf8')
  writeFileSync(skill, '# старый навык\n', 'utf8')

  const result = run(root, ['init', '--refresh', '--json'])
  assert.equal(result.code, 0, result.err)
  const data = JSON.parse(result.out) as { updated: string[] }

  assert.ok(data.updated.some((path) => path.includes('plugins/board/index.ts')))
  assert.ok(data.updated.some((path) => path.includes('skills/board-spec/SKILL.md')))
  assert.match(readFileSync(plugin, 'utf8'), /board_setup/)
  assert.match(readFileSync(skill, 'utf8'), /# board-spec/)
})
