import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, ...env },
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-inbox-'))
  run(dir, ['init'])
  return dir
}

test('inbox показывает запрос, который ждёт решения', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])

  const view = run(dir, ['inbox'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^ЗАПРОСЫ В INBOX$/m)
  assert.match(view.out, /^\s+R1\s+Оплата$/m)
})

test('отложенный запрос в inbox не печатается', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Отложенный'])
  run(dir, ['request', 'later', 'R1', '--until', '2026-12-01'])

  const view = run(dir, ['inbox'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /ЗАПРОСЫ В INBOX/)
  assert.doesNotMatch(view.out, /Отложенный/)
  assert.match(view.out, /ничего не ждёт вас/)
})

test('отложенный запрос не прячет тот, что ждёт решения', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['request', 'add', 'Отложенный'])
  run(dir, ['request', 'later', 'R2', '--until', '2026-12-01'])

  const view = run(dir, ['inbox'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^ЗАПРОСЫ В INBOX$/m)
  assert.match(view.out, /^\s+R1\s+Оплата$/m)
  assert.doesNotMatch(view.out, /R2\s+Отложенный/)
})

test('пустой список запросов не печатает блок', () => {
  const dir = project()

  const view = run(dir, ['inbox'])
  assert.equal(view.code, 0, view.err)
  assert.doesNotMatch(view.out, /ЗАПРОСЫ В INBOX/)
  assert.match(view.out, /ничего не ждёт вас/)
})

test('now по-прежнему считает отложенный запрос открытым', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['request', 'add', 'Отложенный'])
  run(dir, ['request', 'later', 'R2', '--until', '2026-12-01'])

  const view = run(dir, ['now'])
  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /^\tОткрытых запросов: 2$/m, 'nowView.requests не сужали')
})
