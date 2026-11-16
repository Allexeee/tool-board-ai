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

test('request show --history показывает изменения', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-hist-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата', '--body', 'старый текст'])
  run(dir, ['request', 'edit', 'R1', '--title', 'Оплата подписки'])

  const shown = run(dir, ['request', 'show', 'R1', '--history'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /Оплата подписки/)
  assert.match(shown.out, /старый текст/)
})

test('история без правок пуста и не падает', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-hist2-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Просто запрос'])

  const shown = run(dir, ['request', 'show', 'R1', '--history'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /Просто запрос/)
})
