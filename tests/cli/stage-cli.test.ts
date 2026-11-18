import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { makeRepoWithDev } from '../helpers/repo.ts'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
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

test('task session записывает, показывает и сбрасывает сессию', () => {
  const dir = project()
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'а', '--skill', 'backend', '--scope', 'src/**'])

  const empty = run(dir, ['task', 'session', 'F1.S1-1'])
  assert.equal(empty.code, 0, empty.err)
  assert.match(empty.out, /сессия не задана/)

  const bound = run(dir, ['task', 'session', 'F1.S1-1', '--session', 'ses_77'])
  assert.equal(bound.code, 0, bound.err)
  assert.match(bound.out, /ses_77/)

  const shown = run(dir, ['task', 'show', 'F1.S1-1'])
  assert.equal(shown.code, 0, shown.err)
  assert.match(shown.out, /сессия: ses_77/)

  const cleared = run(dir, ['task', 'session', 'F1.S1-1', '--clear'])
  assert.equal(cleared.code, 0, cleared.err)
  assert.doesNotMatch(run(dir, ['task', 'show', 'F1.S1-1']).out, /сессия:/)
})

test('task session без значения сессии объясняет флаг', () => {
  const dir = project()
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'а', '--skill', 'backend', '--scope', 'src/**'])

  const broken = run(dir, ['task', 'session', 'F1.S1-1', '--session'])

  assert.equal(broken.code, 3)
  assert.match(broken.err, /--session/)
})

test('stage merge сбрасывает сессии задач своего этапа', () => {
  const dir = makeRepoWithDev()
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'можно платить', '--appetite', '2 дня'])
  run(dir, ['stage', 'activate', 'F1'])
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'а', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['feature', 'start', 'F1'])
  run(dir, ['task', 'session', 'F1.S1-1', '--session', 'ses_merge'])

  // merge смотрит только на статус задачи: закрываем её без git-отчёта
  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update tasks set status = 'done' where id = 'F1.S1-1'").run()
  db.close()

  const merged = run(dir, ['stage', 'merge', 'F1.S1'])
  assert.equal(merged.code, 0, merged.err + merged.out)

  const shown = run(dir, ['task', 'session', 'F1.S1-1'])
  assert.match(shown.out, /сессия не задана/)
})

test('stage merge не ждёт отложенных и называет их', () => {
  const dir = makeRepoWithDev()
  run(dir, ['init'])
  run(dir, ['request', 'add', 'Оплата'])
  run(dir, ['feature', 'add', 'Оплата', '--request', 'R1'])
  run(dir, ['stage', 'add', 'F1', 'S1', '--goal', 'можно платить', '--appetite', '2 дня'])
  run(dir, ['stage', 'activate', 'F1'])
  run(dir, ['task', 'add', 'F1.S1', 'Шаг', '--dod', 'а', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'add', 'F1.S1', 'Долг', '--dod', 'б', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['feature', 'start', 'F1'])

  const deferred = run(dir, ['task', 'defer', 'F1.S1-2', '--reason', 'ждём решения владельца'])
  assert.equal(deferred.code, 0, deferred.err)

  // merge смотрит только на статус: первую закрываем без git-отчёта
  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare("update tasks set status = 'done' where id = 'F1.S1-1'").run()
  db.close()

  const merged = run(dir, ['stage', 'merge', 'F1.S1'])
  assert.equal(merged.code, 0, merged.err + merged.out)
  assert.match(merged.out, /слит/)
  assert.match(merged.out, /не вошло: F1\.S1-2/, 'отложенная названа, а не тихо пропущена')

  const shown = run(dir, ['task', 'show', 'F1.S1-2'])
  assert.match(shown.out, /статус: deferred/)
  assert.match(shown.out, /причина: ждём решения владельца/)

  assert.doesNotMatch(run(dir, ['task', 'open']).out, /F1\.S1-2/, 'отложенная не в открытых')
})
