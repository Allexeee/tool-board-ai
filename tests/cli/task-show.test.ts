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

const flags = ['--dod', 'шаг сделан', '--skill', 'backend', '--scope', 'src/**']

function stageTask() {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-show-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '1 день'])
  run(dir, ['stage', 'activate', 'F1'])
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', ...flags])
  return dir
}

test('task show печатает решения задачи, этапа и фичи', () => {
  const dir = stageTask()
  run(dir, ['decide', 'add', 'Фича или модуль', '--choice', 'фича', '--reason', 'так проще', '--subject', 'F1'])
  run(dir, ['decide', 'add', 'Какой этап', '--choice', 'первый', '--reason', 'порядок', '--subject', 'F1.S1'])
  run(dir, ['decide', 'add', 'Чем проверять', '--choice', 'тестом', '--reason', 'надёжнее', '--subject', 'F1.S1-1'])

  const shown = run(dir, ['task', 'show', 'F1.S1-1'])

  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /## Решения/)
  assert.match(shown.out, /Чем проверять/)
  assert.match(shown.out, /Какой этап/)
  assert.match(shown.out, /Фича или модуль/)

  const order = ['Чем проверять', 'Какой этап', 'Фича или модуль'].map((text) => shown.out.indexOf(text))
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'от частного к общему')
})

test('у задачи без решений секции нет', () => {
  const dir = stageTask()

  const shown = run(dir, ['task', 'show', 'F1.S1-1'])
  assert.doesNotMatch(shown.out, /## Решения/)
})
