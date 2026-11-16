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

test('task edit меняет поля через CLI и пишет историю', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-edit-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Черновик', '--dod', 'старое условие', '--skill', 'backend', '--scope', 'src/**'])

  const edited = run(dir, ['task', 'edit', 'T1', '--dod', 'новое условие', '--as', 'orchestrator'])
  assert.equal(edited.code, 0)

  const shown = run(dir, ['task', 'show', 'T1'])
  assert.match(shown.out, /новое условие/)

  const history = run(dir, ['task', 'show', 'T1', '--history'])
  assert.equal(history.code, 0)
  assert.match(history.out, /История/)
  assert.match(history.out, /orchestrator/)
  assert.match(history.out, /старое условие/)
  assert.match(history.out, /новое условие/)
})

test('task edit отвергает неизвестное поле со списком допустимых', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-edit-bad-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Черновик', '--dod', 'условие', '--skill', 'backend'])

  const rejected = run(dir, ['task', 'edit', 'T1', '--rank', '2'])
  assert.notEqual(rejected.code, 0)
  assert.match(rejected.err, /неизвестное поле: --rank/)
  assert.match(rejected.err, /--dod/)
})

test('история задачи без правок пуста и не падает', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-hist-empty-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Черновик', '--dod', 'условие', '--skill', 'backend', '--scope', 'src/**'])

  const history = run(dir, ['task', 'show', 'T1', '--history'])
  assert.equal(history.code, 0)
  assert.match(history.out, /изменений нет/)
})
