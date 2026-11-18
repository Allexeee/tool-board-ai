import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const bin = resolve('bin/toolbox-al.ts')

function run(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true })
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
  assert.match(brief.out, /^дальше: node bin\/toolbox-al\.ts task context T1$/m)
  assert.doesNotMatch(brief.out, /task show T1/, 'второй команды «дальше» больше нет')
})

test('task brief не пересказывает роль: правила живут в файле агента', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const brief = run(dir, ['task', 'brief', 'T1', '--as', 'w1'])
  assert.equal(brief.code, 0, brief.err)
  assert.doesNotMatch(brief.out, /роль:/)
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

test('task brief печатает DoD и область, но не код', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'тайный критерий', '--skill', 'backend', '--scope', 'src/**'])
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src/a.ts'), 'const secret = 1')

  const brief = run(dir, ['task', 'brief', 'T1'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /^DoD: тайный критерий$/m)
  assert.match(brief.out, /^область: src\/\*\*$/m)
  assert.doesNotMatch(brief.out, /const secret/, 'содержимое файлов в бриф не входит')
})

test('task brief печатает зависимости задачи', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Первая', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])
  run(dir, ['task', 'add', 'Вторая', '--dod', 'готово', '--skill', 'backend', '--scope', 'tests/**'])
  run(dir, ['task', 'add', 'Третья', '--dod', 'готово', '--skill', 'backend', '--scope', 'docs/**'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  db.prepare('insert into deps (from_id, to_id) values (?, ?)').run('T3', 'T1')
  db.prepare('insert into deps (from_id, to_id) values (?, ?)').run('T3', 'T2')
  db.close()

  const brief = run(dir, ['task', 'brief', 'T3', '--as', 'w1'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /^зависит от: T1, T2$/m)
  assert.match(brief.out, /^навык: backend$/m)
  assert.match(brief.out, /^DoD: готово$/m)
  assert.match(brief.out, /^область: docs\/\*\*$/m)
  assert.match(brief.out, /^дальше: node bin\/toolbox-al\.ts task context T3$/m)
})

test('task brief без зависимостей и пустых полей не печатает пустые строки', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Одна', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const db = new DatabaseSync(join(dir, '.toolbox-al/tracker.db'))
  // пустые значения возможны в старой базе: бриф не должен печатать «навык:» без навыка
  db.prepare("update tasks set skill = '', scope = '[]' where id = 'T1'").run()
  db.close()

  const brief = run(dir, ['task', 'brief', 'T1'])
  assert.equal(brief.code, 0, brief.err)
  assert.doesNotMatch(brief.out, /зависит от:/)
  assert.doesNotMatch(brief.out, /^навык:/m)
  assert.doesNotMatch(brief.out, /^область:/m)
  for (const line of brief.out.split('\n')) {
    assert.doesNotMatch(line, /:\s*$/, `пустое поле в брифе: ${line}`)
  }
})

test('task brief печатает заметку задачи', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**', '--note', 'ключ в .env'])

  const brief = run(dir, ['task', 'brief', 'T1', '--as', 'w1'])
  assert.equal(brief.code, 0, brief.err)
  assert.match(brief.out, /^заметка: ключ в \.env$/m)

  // заметка стоит до «дальше»: сначала данные задачи, потом команда
  assert.ok(brief.out.indexOf('заметка:') < brief.out.indexOf('дальше:'), brief.out)
})

test('task brief без заметки не печатает пустую строку', () => {
  const dir = project()
  run(dir, ['task', 'add', 'Бриф', '--dod', 'готово', '--skill', 'backend', '--scope', 'src/**'])

  const brief = run(dir, ['task', 'brief', 'T1'])
  assert.equal(brief.code, 0, brief.err)
  assert.doesNotMatch(brief.out, /заметка:/)
})

test('task brief без id объясняет использование', () => {
  const dir = project()

  const brief = run(dir, ['task', 'brief'])
  assert.equal(brief.code, 3)
  assert.match(brief.err, /использование: task brief/)
})
