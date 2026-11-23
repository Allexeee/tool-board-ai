import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
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

function json(dir: string, args: string[], env: NodeJS.ProcessEnv = {}): Record<string, any> {
  const result = run(dir, [...args, '--json'], env)
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

function project(t: { after: (fn: () => void) => void }) {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

function shaped(dir: string): void {
  assert.equal(run(dir, ['card', 'add', '--group', 'UI', '--title', 'Форма', '--skill', 'dev']).code, 0)
  assert.equal(run(dir, ['card', 'shape', 'UI-1', '--as', 'developer']).code, 0)
  assert.equal(
    run(dir, [
      'card', 'edit', 'UI-1',
      '--spec', 'Нужен вход',
      '--acceptance', 'Вход работает',
      '--importance', '2',
      '--urgency', '2',
      '--scope', 'src/**',
    ]).code,
    0,
  )
}

test('spec review: self проходит, submit и approve открываются', (t) => {
  const { root } = project(t)
  json(root, ['setup', '--spec-review', 'self'])
  shaped(root)

  const before = run(root, ['card', 'submit', 'UI-1', '--as', 'developer'])
  assert.equal(before.code, 2)
  assert.match(before.err, /spec review/)

  const review = json(root, [
    'card', 'spec-review', 'UI-1',
    '--as', 'developer',
    '--mode', 'self',
    '--verdict', 'done',
    '--note', 'полно',
  ])
  assert.equal(review.kind, 'spec')
  assert.equal(review.mode, 'self')
  assert.equal(review.verdict, 'done')

  const submitted = run(root, ['card', 'submit', 'UI-1', '--as', 'developer'])
  assert.equal(submitted.code, 0, submitted.err)
  assert.equal(run(root, ['card', 'approve', 'UI-1', '--as', 'owner']).code, 0)

  const shown = json(root, ['card', 'show', 'UI-1'])
  assert.equal(shown.specReview.mode, 'self')
  assert.equal(shown.specReviewLatest.kind, 'spec')
})

test('amend после approve сбрасывает spec review и требует новый', (t) => {
  const { root } = project(t)
  json(root, ['setup', '--spec-review', 'self'])
  shaped(root)
  json(root, ['card', 'spec-review', 'UI-1', '--as', 'developer', '--mode', 'self', '--verdict', 'done'])
  assert.equal(run(root, ['card', 'submit', 'UI-1', '--as', 'developer']).code, 0)
  assert.equal(run(root, ['card', 'approve', 'UI-1', '--as', 'owner']).code, 0)

  const locked = run(root, ['card', 'edit', 'UI-1', '--spec', 'новый spec'])
  assert.equal(locked.code, 3)
  assert.match(locked.err, /amend|spec/)

  const amended = run(root, [
    'card', 'amend', 'UI-1',
    '--as', 'developer',
    '--reason', 'уточнили spec',
  ])
  assert.equal(amended.code, 0, amended.err)
  assert.equal(json(root, ['card', 'show', 'UI-1']).status, 'shaping')

  const stale = run(root, ['card', 'submit', 'UI-1', '--as', 'developer'])
  assert.equal(stale.code, 2)

  json(root, ['card', 'spec-review', 'UI-1', '--as', 'developer', '--mode', 'self', '--verdict', 'done'])
  assert.equal(run(root, ['card', 'submit', 'UI-1', '--as', 'developer']).code, 0)
  assert.equal(run(root, ['card', 'approve', 'UI-1', '--as', 'owner']).code, 0)
})

test('auto на Max требует субагента, self не принимается', (t) => {
  const { root } = project(t)
  json(root, [
    'setup',
    '--spec-review', 'auto',
    '--reviewer-model', 'opencode-go/deepseek-v4.1-flash',
  ])
  shaped(root)
  const env = { BOARD_MODEL_VARIANT: 'max', BOARD_SESSION_MODEL: 'opencode-go/deepseek-v4.1-flash' }

  const shown = json(root, ['card', 'show', 'UI-1'], env)
  assert.equal(shown.specReview.mode, 'subagent')

  const selfReview = run(root, [
    'card', 'spec-review', 'UI-1',
    '--as', 'developer',
    '--mode', 'self',
    '--verdict', 'done',
  ], env)
  assert.equal(selfReview.code, 2)
  assert.match(selfReview.err, /субагент/)

  const subagentReview = run(root, [
    'card', 'spec-review', 'UI-1',
    '--as', 'reviewer',
    '--mode', 'subagent',
    '--verdict', 'done',
  ], env)
  assert.equal(subagentReview.code, 0, subagentReview.err)

  const submitted = run(root, ['card', 'submit', 'UI-1', '--as', 'developer'], env)
  assert.equal(submitted.code, 0, submitted.err)
})

test('subagent без reviewer.model — ошибка с подсказкой', (t) => {
  const { root } = project(t)
  json(root, ['setup', '--spec-review', 'subagent'])
  shaped(root)

  const result = run(root, ['card', 'submit', 'UI-1', '--as', 'developer'])
  assert.equal(result.code, 2)
  assert.match(result.err, /reviewer\.model|--reviewer-model/)

  const review = run(root, [
    'card', 'spec-review', 'UI-1',
    '--as', 'reviewer',
    '--mode', 'subagent',
    '--verdict', 'done',
  ])
  assert.equal(review.code, 2)
})
