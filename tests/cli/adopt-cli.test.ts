import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeBoard } from '../helpers/board.ts'

const bin = resolve('bin/board.ts')

function run(dir: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, BOARD_ALLOW_GLOBAL: '1', ...env },
    windowsHide: true,
  })
}

test('adopt --check: CLI отдаёт план и не пишет на диск', (t) => {  const board = makeBoard()
  t.after(board.close)
  mkdirSync(join(board.root, 'docs', 'inbox'), { recursive: true })
  writeFileSync(join(board.root, 'docs', 'inbox', 'task.md'), '# Починить вход\n')

  const before = readFileSync(join(board.root, '.board', 'settings.json'), 'utf8')
  const result = run(board.root, ['adopt', '--check', '--json'])
  assert.equal(result.status, 0, result.stderr || result.stdout)

  const plan = JSON.parse(result.stdout) as {
    groups: { missing: Array<{ prefix: string }> }
    sources: Array<{ title: string }>
    steps: Array<{ command: string }>
    required: number
  }
  assert.deepEqual(plan.groups.missing.map((group) => group.prefix), ['CARD'])
  assert.deepEqual(plan.sources.map((source) => source.title), ['feat: Починить вход'])
  assert.ok(plan.steps.some((step) => step.command.startsWith('board group add CARD')))
  assert.equal(plan.required, 2)
  assert.equal(readFileSync(join(board.root, '.board', 'settings.json'), 'utf8'), before)
  assert.equal(existsSync(join(board.root, 'docs', 'board', 'BACKLOG.md')), false)
})

test('adopt без --check: понятная ошибка использования', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const result = run(board.root, ['adopt'])
  assert.equal(result.status, 3)
  assert.match(result.stderr, /board adopt --check/)
})

test('adopt --check: без варианта не советует auto, с флагом советует', (t) => {
  const board = makeBoard()
  t.after(board.close)
  run(board.root, ['setup', '--profile', 'max'])

  const plain = run(board.root, ['adopt', '--check', '--json'], { BOARD_MODEL_VARIANT: '' })
  assert.equal(plain.status, 0, plain.stderr)
  const withoutVariant = JSON.parse(plain.stdout) as {
    profile: { command: string | null }
    steps: Array<{ command: string }>
  }
  assert.equal(withoutVariant.profile.command, null)
  assert.equal(
    withoutVariant.steps.some((step) => step.command === 'board setup --profile auto'),
    false,
  )

  const withVariant = run(board.root, [
    'adopt', '--check', '--json', '--model-variant', 'max',
  ])
  assert.equal(withVariant.status, 0, withVariant.stderr)
  const known = JSON.parse(withVariant.stdout) as { profile: { command: string | null } }
  assert.equal(known.profile.command, 'board setup --profile auto --model-variant max')
})
