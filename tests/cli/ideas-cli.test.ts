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
  const dir = mkdtempSync(join(tmpdir(), 'al-ideas-'))
  run(dir, ['init'])
  return dir
}

test('idea edit меняет текст, realize убирает из списка', () => {
  const dir = project()
  run(dir, ['idea', 'add', 'Старое'])

  const edited = run(dir, ['idea', 'edit', 'I1', '--text', 'Новое'])
  assert.equal(edited.code, 0, edited.err)
  assert.match(edited.out, /Новое/)

  const realized = run(dir, ['idea', 'realize', 'I1'])
  assert.equal(realized.code, 0, realized.err)

  const list = run(dir, ['idea', 'list'])
  assert.doesNotMatch(list.out, /Новое/)

  const all = run(dir, ['idea', 'list', '--all'])
  assert.match(all.out, /Новое/)
})

test('idea remove удаляет свободную и отказывает продвинутой', () => {
  const dir = project()
  run(dir, ['idea', 'add', 'Свободная'])
  run(dir, ['idea', 'add', 'В работу'])

  const removed = run(dir, ['idea', 'remove', 'I1'])
  assert.equal(removed.code, 0, removed.err)

  run(dir, ['idea', 'promote', 'I2'])
  const denied = run(dir, ['idea', 'remove', 'I2'])
  assert.notEqual(denied.code, 0)
  assert.match(denied.err, /запрос/)
})
