import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')
const tmp = () => mkdtempSync(join(tmpdir(), 'al-pool-cli-'))

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

const flags = ['--dod', 'опечатки нет', '--size', 'XS', '--skill', 'backend', '--class', 'quick', '--scope', 'docs/**']

test('task add без этапа создаёт задачу пула', () => {
  const dir = tmp()
  run(dir, ['init'])

  const created = run(dir, ['task', 'add', 'Поправить опечатку', ...flags])
  assert.equal(created.code, 0)
  assert.match(created.out, /T1/)

  const shown = run(dir, ['task', 'show', 'T1'])
  assert.equal(shown.code, 0)
  assert.match(shown.out, /T1/)
})

test('task add с этапом создаёт задачу этапа, а не пула', () => {
  const dir = tmp()
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '2 дня'])
  run(dir, ['stage', 'activate', 'F1'])

  const created = run(dir, ['task', 'add', 'F1.S1', 'Сделать вебхук', ...flags])
  assert.equal(created.code, 0)
  assert.match(created.out, /F1\.S1-1/)
})
