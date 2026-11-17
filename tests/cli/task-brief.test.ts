import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-brief-'))
  run(dir, ['init'])
  run(dir, ['executor', 'add', 'w1', '--skills', 'backend'])
  return dir
}

test('task brief печатает роль, ограничения, каталог и id задачи', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const brief = run(dir, ['task', 'brief', 'T1', '--as', 'w1'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /id: T1/)
  assert.match(brief.out, /роль: исполнитель w1 · навык backend/)
  assert.ok(brief.out.includes(`каталог: ${dir}`) || brief.out.includes(basename(dir)), brief.out)
  assert.match(brief.out, /ограничения:/)
  assert.match(brief.out, /не запускать git/)
  assert.match(brief.out, /task show T1/)
  assert.match(brief.out, /task context T1/)
})

test('task brief берёт роль из держателя задачи', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['take', 'T1', '--as', 'w1'])

  const brief = run(dir, ['task', 'brief', 'T1'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /роль: исполнитель w1/)
})

test('task brief не дублирует DoD и код', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'тайный критерий', '--skill', 'backend', '--scope', 'src/**'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'const secret = 1')

  const brief = run(dir, ['task', 'brief', 'T1'])
  assert.equal(brief.code, 0, brief.err)
  assert.doesNotMatch(brief.out, /DoD:/)
  assert.doesNotMatch(brief.out, /тайный критерий/)
  assert.doesNotMatch(brief.out, /const secret/)
})

test('task brief без id объясняет использование', () => {
  const dir = project()

  const brief = run(dir, ['task', 'brief'])
  assert.equal(brief.code, 3)
  assert.match(brief.err, /использование: task brief/)
})
