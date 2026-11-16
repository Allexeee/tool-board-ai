import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')
const flags = ['--dod', 'опечатки нет', '--size', 'XS', '--skill', 'backend', '--class', 'quick', '--scope', 'docs/**']

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-poolsub-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Первая', ...flags])
  run(dir, ['task', 'add', 'Вторая', ...flags])
  return dir
}

test('pool remove убирает задачу из пула', () => {
  const dir = project()
  const result = run(dir, ['pool', 'remove', 'T1', '--reason', 'не нужно'])

  assert.equal(result.code, 0)
  assert.doesNotMatch(result.out, /T1\s+quick/)
  assert.match(result.out, /убрана/)
})

test('pool merge переносит DoD и отменяет источник', () => {
  const dir = project()
  const result = run(dir, ['pool', 'merge', 'T2', 'T1'])

  assert.equal(result.code, 0)
  assert.match(result.out, /T2 → T1/)

  const shown = run(dir, ['task', 'show', 'T2'])
  assert.match(shown.out, /cancelled/)
})

test('pool stale не путается с pool list', () => {
  const dir = project()
  const result = run(dir, ['pool', 'stale'])

  assert.equal(result.code, 0)
  assert.match(result.out, /пул пуст/)
})

test('pool list печатает статус задачи', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const listed = run(dir, ['pool', 'list'])
  assert.equal(listed.code, 0)
  assert.match(listed.out, /T1\s+\w+\s/)
})
