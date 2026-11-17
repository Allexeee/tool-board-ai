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
