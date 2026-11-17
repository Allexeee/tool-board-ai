import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-exec-'))
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  return dir
}

function json(dir: string, args: string[]) {
  const result = run(dir, [...args, '--json'])
  assert.equal(result.code, 0, result.err)
  return JSON.parse(result.out)
}

test('bind сохраняет сессию, session показывает, reset отвязывает', () => {
  const dir = project()

  const bound = run(dir, ['executor', 'bind', 'w1', '--session', 'ses_abc'])
  assert.equal(bound.code, 0, bound.err)
  assert.match(bound.out, /ses_abc/)

  const shown = run(dir, ['executor', 'session', 'w1'])
  assert.match(shown.out, /ses_abc/)

  const reset = run(dir, ['executor', 'reset', 'w1'])
  assert.equal(reset.code, 0, reset.err)

  const after = run(dir, ['executor', 'session', 'w1'])
  assert.match(after.out, /сессия не привязана/)
})

test('dispatch печатает сессию исполнителя', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-dispatch-ses-'))
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['executor', 'bind', 'w1', '--session', 'ses_77'])

  const plan = run(dir, ['dispatch'])
  assert.equal(plan.code, 0, plan.err)
  assert.match(plan.out, /сессия: ses_77/)
})

test('без сессии dispatch печатается как раньше', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-dispatch-noses-'))
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const plan = run(dir, ['dispatch'])
  assert.doesNotMatch(plan.out, /сессия:/)
})

test('bind без сессии объясняет, что нужно', () => {
  const dir = project()
  const bound = run(dir, ['executor', 'bind', 'w1'])

  assert.notEqual(bound.code, 0)
  assert.match(bound.err, /--session/)
})

test('bind несуществующего исполнителя отвергается', () => {
  const dir = project()
  const bound = run(dir, ['executor', 'bind', 'nobody', '--session', 'ses_x'])

  assert.notEqual(bound.code, 0)
  assert.match(bound.err, /не найден/)
})

test('add принимает модель, права и лимит шагов', () => {
  const dir = project()

  const added = json(dir, [
    'executor', 'add', 'w2',
    '--skills', 'backend',
    '--model', 'opencode/gpt-5',
    '--steps', '12',
    '--allow', 'shell:git *',
    '--deny', 'edit:*',
  ])

  assert.equal(added.id, 'w2')
  assert.equal(added.model, 'opencode/gpt-5')
  assert.equal(added.steps, 12)
  assert.deepEqual(added.permissions, [
    { action: 'shell', resource: 'git *', effect: 'allow' },
    { action: 'edit', resource: '*', effect: 'deny' },
  ])
})

test('model, permissions и steps меняют значения', () => {
  const dir = project()

  const modeled = json(dir, ['executor', 'model', 'w1', '--model', 'anthropic/claude-sonnet-4-5'])
  assert.equal(modeled.model, 'anthropic/claude-sonnet-4-5')

  const permitted = json(dir, [
    'executor', 'permissions', 'w1',
    '--allow', 'shell:git *',
    '--deny', 'edit:src/core/**',
  ])
  assert.deepEqual(permitted.permissions, [
    { action: 'shell', resource: 'git *', effect: 'allow' },
    { action: 'edit', resource: 'src/core/**', effect: 'deny' },
  ])

  const stepped = json(dir, ['executor', 'steps', 'w1', '--steps', '7'])
  assert.equal(stepped.steps, 7)

  const inherited = json(dir, ['executor', 'model', 'w1', '--model', 'inherit'])
  assert.equal(inherited.model, null)
})

test('permissions --clear снимает все правила', () => {
  const dir = project()
  json(dir, ['executor', 'permissions', 'w1', '--allow', 'shell:git *'])

  const cleared = json(dir, ['executor', 'permissions', 'w1', '--clear'])
  assert.deepEqual(cleared.permissions, [])
})

test('модель не в формате provider/model объясняет формат', () => {
  const dir = project()
  const result = run(dir, ['executor', 'model', 'w1', '--model', 'gpt-5'])

  assert.notEqual(result.code, 0)
  assert.match(result.err, /provider\/model/)
})

test('шаги и права без значений объясняют использование', () => {
  const dir = project()

  const steps = run(dir, ['executor', 'steps', 'w1'])
  assert.notEqual(steps.code, 0)
  assert.match(steps.err, /--steps/)

  const permissions = run(dir, ['executor', 'permissions', 'w1'])
  assert.notEqual(permissions.code, 0)
  assert.match(permissions.err, /--allow/)
})
