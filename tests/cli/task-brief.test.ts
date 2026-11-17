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

test('task brief печатает агента, файл агента, каталог и id задачи', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const brief = run(dir, ['task', 'brief', 'T1', '--as', 'w1'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /id: T1/)
  assert.match(brief.out, /агент: w1/)
  assert.match(brief.out, /файл агента: \.opencode\/agents\/w1\.md/)
  assert.ok(brief.out.includes(`каталог: ${dir}`) || brief.out.includes(basename(dir)), brief.out)
  assert.match(brief.out, /task show T1/)
  assert.match(brief.out, /task context T1/)
})

test('task brief не пересказывает роль: навыки и правила живут в файле агента', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const brief = run(dir, ['task', 'brief', 'T1', '--as', 'w1'])
  assert.equal(brief.code, 0, brief.err)
  assert.doesNotMatch(brief.out, /роль:/)
  assert.doesNotMatch(brief.out, /навык/)
  assert.doesNotMatch(brief.out, /ограничения:/)
  assert.doesNotMatch(brief.out, /не запускать git/)
  assert.doesNotMatch(brief.out, /только файлы области/)
})

test('task brief берёт агента из держателя задачи', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['take', 'T1', '--as', 'w1'])

  const brief = run(dir, ['task', 'brief', 'T1'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /агент: w1/)
})

test('task brief без исполнителя честно говорит, что агент не назначен', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const brief = run(dir, ['task', 'brief', 'T1'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /агент: не назначен/)
  assert.doesNotMatch(brief.out, /файл агента:/)
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
