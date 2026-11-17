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

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-now-'))
  run(dir, ['init'])
  return dir
}

test('now показывает запрос в inbox и план на утверждение', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])

  const view = run(dir, ['now'])
  assert.match(view.out, /ЗАПРОСЫ В INBOX/)
  assert.match(view.out, /Оплата/)
})

test('now показывает, сколько этапов не выпущено', () => {
  const dir = project()
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'g', '--appetite', '1 день'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update stages set status = 'merged', merged_at = ? where id = 'F1.S1'").run(
    new Date().toISOString(),
  )
  db.close()

  const view = run(dir, ['now'])
  assert.match(view.out, /НЕ ВЫПУЩЕНО/)
  assert.match(view.out, /release pending/)
})

test('now на пустом проекте говорит, что работы нет', () => {
  const dir = project()
  const view = run(dir, ['now'])

  assert.equal(view.code, 0, view.err)
  assert.match(view.out, /фич в работе нет/)
})

test('now прячет завершённые фичи, а --all показывает', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Сделано'])
  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update features set status = 'done' where id = 'F1'").run()
  db.close()

  const hidden = run(dir, ['now'])
  assert.doesNotMatch(hidden.out, /Сделано/)
  assert.match(hidden.out, /фич в работе нет/)

  const all = run(dir, ['now', '--all'])
  assert.match(all.out, /Сделано/)
})

test('now показывает фичу в работе', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'В работе'])

  const view = run(dir, ['now'])
  assert.match(view.out, /В работе/)
})

test('now показывает решение рядом с фичей', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Оплата'])
  run(dir, ['decide', 'add', 'Провайдер', '--choice', 'ЮKassa', '--reason', 'договор', '--subject', 'F1'])

  const view = run(dir, ['now'])
  assert.match(view.out, /Провайдер → ЮKassa/)
})

test('фича без решений печатается как раньше', () => {
  const dir = project()
  run(dir, ['feature', 'add', 'Без решений'])

  const view = run(dir, ['now'])
  assert.doesNotMatch(view.out, /→/)
})

test('now показывает свободного исполнителя и пустую руку', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const view = run(dir, ['now'])
  assert.match(view.out, /w1\s+свободен · рука пуста/)
})

test('now показывает очередь руки исполнителя', () => {
  const dir = project()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['task', 'add', 'Пул', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'list'])
  run(dir, ['hand', 'set', 'T1', '--as', 'w1'])

  const view = run(dir, ['now'])
  assert.match(view.out, /w1\s+свободен · рука: T1/)
})
