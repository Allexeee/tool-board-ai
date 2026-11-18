import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
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

const agentFile = (dir: string, id: string) => join(dir, '.opencode', 'agents', `${id}.md`)

test('sync w1 создаёт файл агента OpenCode', () => {
  const dir = project()

  const synced = run(dir, ['executor', 'sync', 'w1'])

  assert.equal(synced.code, 0, synced.err)
  assert.match(synced.out, /w1: создан/)
  assert.match(synced.out, /\.opencode\/agents\/w1\.md/)

  const text = readFileSync(agentFile(dir, 'w1'), 'utf8')
  assert.match(text, /^---\n/)
  assert.match(text, /^mode: subagent$/m)
  assert.match(text, /^steps: 60$/m)
  assert.match(text, /^description: "исполнитель w1 · навыки: backend"$/m)
  assert.match(text, /take --as w1/)
})

test('sync переносит в файл модель, права и непустой лимит шагов', () => {
  const dir = project()
  json(dir, ['executor', 'model', 'w1', '--model', 'opencode/gpt-5'])
  json(dir, ['executor', 'steps', 'w1', '--steps', '9'])
  json(dir, ['executor', 'permissions', 'w1', '--allow', 'shell:git *'])

  assert.equal(run(dir, ['executor', 'sync', 'w1']).code, 0)

  const text = readFileSync(agentFile(dir, 'w1'), 'utf8')
  assert.match(text, /^model: opencode\/gpt-5$/m)
  assert.match(text, /^steps: 9$/m)
  assert.match(text, /resource: "git \*"/)
  assert.match(text, /effect: allow/)
})

test('наследованная модель не попадает в файл', () => {
  const dir = project()
  json(dir, ['executor', 'model', 'w1', '--model', 'inherit'])

  assert.equal(run(dir, ['executor', 'sync', 'w1']).code, 0)

  assert.doesNotMatch(readFileSync(agentFile(dir, 'w1'), 'utf8'), /^model:/m)
})

test('повторный sync без изменений в базе не трогает файл', () => {
  const dir = project()
  run(dir, ['executor', 'sync', 'w1'])
  const before = statSync(agentFile(dir, 'w1')).mtimeMs
  const content = readFileSync(agentFile(dir, 'w1'), 'utf8')

  const again = run(dir, ['executor', 'sync'])

  assert.equal(again.code, 0, again.err)
  assert.match(again.out, /без изменений/)
  assert.match(again.out, /создано: 0, обновлено: 0/)
  assert.equal(statSync(agentFile(dir, 'w1')).mtimeMs, before)
  assert.equal(readFileSync(agentFile(dir, 'w1'), 'utf8'), content)
})

test('sync без id пишет файл на каждого агента', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w2', '--skills', 'frontend'])

  const all = run(dir, ['executor', 'sync'])

  assert.equal(all.code, 0, all.err)
  assert.match(all.out, /создано: 2/)
  assert.equal(existsSync(agentFile(dir, 'w1')), true)
  assert.equal(existsSync(agentFile(dir, 'w2')), true)
})

test('sync несуществующего исполнителя отвергается', () => {
  const dir = project()
  const result = run(dir, ['executor', 'sync', 'nobody'])

  assert.notEqual(result.code, 0)
  assert.match(result.err, /не найден/)
})

test('sync объясняет, что человеку файл агента не нужен', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'owner', '--kind', 'human', '--skills', 'backend'])

  const result = run(dir, ['executor', 'sync', 'owner'])

  assert.equal(result.code, 0, result.err)
  assert.match(result.out, /человек/)
  assert.equal(existsSync(agentFile(dir, 'owner')), false)
})

test('doctor видит расхождение файла агента с базой, а sync его чинит', () => {
  const dir = project()
  run(dir, ['executor', 'sync'])

  appendFileSync(agentFile(dir, 'w1'), '\nправка руками\n', 'utf8')
  const dirty = run(dir, ['doctor'])

  assert.equal(dirty.code, 1, dirty.out)
  assert.match(dirty.out, /агенты OpenCode/)
  assert.match(dirty.out, /w1 \(правлен руками\)/)
  assert.match(dirty.out, /executor sync/)

  const fixed = run(dir, ['executor', 'sync'])
  assert.match(fixed.out, /обновлён/)

  const clean = run(dir, ['doctor'])
  assert.equal(clean.code, 0, clean.out + clean.err)
  assert.match(clean.out, /файлы сходятся с базой: 1/)
})

test('doctor без каталога агентов говорит расхождение, но не падает', () => {
  const dir = project()

  const report = run(dir, ['doctor'])

  assert.equal(report.code, 1)
  assert.equal(report.err, '')
  assert.match(report.out, /агенты OpenCode\s+расходятся с базой: w1 \(нет файла\)/)
})
