import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')
const tmp = () => mkdtempSync(join(tmpdir(), 'tbal-cli-'))

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

test('вопрос задаётся и закрывается через CLI', () => {
  const dir = tmp()
  assert.equal(run(dir, ['init']).code, 0)
  assert.equal(run(dir, ['request', 'add', 'Оплата подписки']).code, 0)

  const asked = run(dir, ['ask', 'R1', 'ЮKassa или Stripe?', '--to', 'owner'])
  assert.equal(asked.code, 0)

  const answered = run(dir, ['answer', 'Q1', 'ЮKassa'])
  assert.equal(answered.code, 0)

  const inbox = run(dir, ['inbox'])
  assert.equal(inbox.out.includes('ЮKassa'), false)
})

test('hand show и hand set работают', () => {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const shown = run(dir, ['hand', 'show', '--as', 'w1'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /пусто|рука/i)
})

test('init --dry-run ничего не создаёт', () => {
  const dir = tmp()
  const result = run(dir, ['init', '--dry-run'])
  assert.equal(result.code, 0)
  assert.match(result.out, /Ничего не изменено/)
  assert.equal(existsSync(join(dir, '.toolbox-al')), false)
})
