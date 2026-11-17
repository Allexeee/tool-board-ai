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
  const dir = mkdtempSync(join(tmpdir(), 'al-stage-'))
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'можно платить', '--appetite', '2 дня'])
  run(dir, ['stage', 'activate', 'F1'])
  return dir
}

test('stage show печатает цель, приёмку и задачи', () => {
  const dir = project()
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'а', '--skill', 'backend', '--scope', 'src/**'])

  const shown = run(dir, ['stage', 'show', 'F1.S1'])
  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /можно платить/)
  assert.match(shown.out, /appetite: 2 дня/)
  assert.match(shown.out, /приёмка: /)
  assert.match(shown.out, /## Задачи/)
  assert.match(shown.out, /F1\.S1-1/)
})

test('stage list без фичи подсказывает, а не молчит', () => {
  const dir = project()
  const listed = run(dir, ['stage', 'list'])

  assert.equal(listed.code, 3)
  assert.match(listed.err, /stage list F1/)
})

test('accept говорит, что дальше', () => {
  const dir = project()
  const accepted = run(dir, ['stage', 'accept', 'F1.S1'])

  assert.equal(accepted.code, 0, accepted.err)
  assert.match(accepted.out, /принят/)
  assert.match(accepted.out, /дальше stage merge/)
})
