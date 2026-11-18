import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
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

test('task show печатает сессию держателя', () => {
  const dir = stageTask()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  run(dir, ['executor', 'bind', 'w1', '--session', 'ses_42'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = 'F1.S1-1'").run()
  db.close()

  const shown = run(dir, ['task', 'show', 'F1.S1-1'])
  assert.match(shown.out, /сессия: ses_42/)
})

test('без сессии строки нет', () => {
  const dir = stageTask()
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update tasks set status = 'active', holder = 'w1' where id = 'F1.S1-1'").run()
  db.close()

  const shown = run(dir, ['task', 'show', 'F1.S1-1'])
  assert.doesNotMatch(shown.out, /сессия:/)
})

test('у задачи без решений секции нет', () => {
  const dir = stageTask()

  const shown = run(dir, ['task', 'show', 'F1.S1-1'])
  assert.doesNotMatch(shown.out, /## Решения/)
})

test('карточка печатает отчёт, коммит и ревью', () => {
  const dir = stageTask()
  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare(
    "insert into events (at, type, actor, subject, before, after, note) values (?, 'task.done', 'w1', 'F1.S1-1', null, ?, null)",
  ).run(
    new Date().toISOString(),
    JSON.stringify({ summary: 'сделано', checks: ['npm test'], commit: 'abcdef1234567890' }),
  )
  db.prepare(
    "insert into reviews (task_id, reviewer, verdict, comments, at) values ('F1.S1-1', 'reviewer', 'approved', 'ок', ?)",
  ).run(new Date().toISOString())
  db.close()

  const shown = run(dir, ['task', 'show', 'F1.S1-1'])

  assert.match(shown.out, /## Отчёт/)
  assert.match(shown.out, /сделано/)
  assert.match(shown.out, /проверено: npm test/)
  assert.match(shown.out, /коммит: abcdef12/)
  assert.match(shown.out, /## Ревью/)
  assert.match(shown.out, /approved — reviewer: ок/)
})

