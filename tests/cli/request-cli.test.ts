import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

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

test('show печатает фичи, решения и историю', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-show-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['decide', 'add', 'Какой провайдер', '--choice', 'ЮKassa', '--reason', 'договор'])

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /F1/)
  assert.match(shown.out, /Решения/)
  assert.match(shown.out, /История/)
})

test('request close закрывает запрос, show печатает причину', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-close-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Уже сделано'])

  const closed = run(dir, ['request', 'close', 'R1', '--reason', 'реализовано в F4'])
  assert.equal(closed.code, 0)

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.match(shown.out, /статус: closed/)
  assert.match(shown.out, /закрыт: реализовано в F4/)
})

test('у закрытого слиянием запроса строки с причиной нет', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-req-close2-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Слито'])
  const db = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  db.prepare("update requests set status = 'closed' where id = 'R1'").run()
  db.close()

  const shown = run(dir, ['request', 'show', 'R1'])
  assert.equal(shown.code, 0)
  assert.doesNotMatch(shown.out, /закрыт:/)
})

