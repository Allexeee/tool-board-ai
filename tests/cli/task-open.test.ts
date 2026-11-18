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

const flags = ['--dod', 'сделано', '--skill', 'backend', '--scope', 'src/**']

test('task open печатает незакрытые задачи и не печатает done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-open-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Осталась', ...flags])
  run(dir, ['task', 'add', 'Сделана', ...flags])

  // закрываем вторую задачу вручную: take+done требует git-репозиторий
  const database = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  database.prepare("update tasks set status = 'done' where id = 'T2'").run()
  database.close()

  const opened = run(dir, ['task', 'open'])
  assert.equal(opened.code, 0)
  assert.match(opened.out, /Осталась/)
  assert.doesNotMatch(opened.out, /Сделана/)
})

test('task open на пустом срезе говорит об этом', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-open-empty-'))
  run(dir, ['init'])

  const opened = run(dir, ['task', 'open'])
  assert.equal(opened.code, 0)
  assert.match(opened.out, /открытых задач нет/)
})

test('task open показывает причину блокировки', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-open-why-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Ждёт', ...flags])

  const database = new DatabaseSync(join(dir, '.toolbox-al', 'tracker.db'))
  database.prepare("update tasks set status = 'blocked', reason = 'нет доступа' where id = 'T1'").run()
  database.close()

  const opened = run(dir, ['task', 'open'])
  assert.match(opened.out, /нет доступа/)
})

test('task open --brief печатает только id и статус', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-open-brief-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Первая', ...flags])
  run(dir, ['task', 'add', 'Вторая', ...flags])

  const brief = run(dir, ['task', 'open', '--brief'])
  assert.equal(brief.code, 0, brief.err)
  const lines = brief.out.trimEnd().split('\n')
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^T1\s+ready$/)
  assert.match(lines[1], /^T2\s+ready$/)
  assert.doesNotMatch(brief.out, /Первая|Вторая/)
})

test('task open --brief без открытых задач говорит об этом', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-open-brief-empty-'))
  run(dir, ['init'])

  const brief = run(dir, ['task', 'open', '--brief'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /открытых задач нет/)
})

test('task open без флага печатает заголовки как раньше', () => {
  const dir = mkdtempSync(join(tmpdir(), 'al-task-open-full-'))
  run(dir, ['init'])
  run(dir, ['task', 'add', 'Первая', ...flags])

  const full = run(dir, ['task', 'open'])
  assert.equal(full.code, 0, full.err)
  assert.match(full.out, /^T1\s+ready\s+Первая$/m)
})
