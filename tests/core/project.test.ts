import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initProject, findProject } from '../../src/core/project.ts'
import { runInit } from '../../src/cli/commands/init.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'tbal-'))

test('init идемпотентен и не затирает конфиг', () => {
  const dir = tmp()
  const r1 = initProject(dir)
  assert.ok(r1.created.includes('.toolbox-al/config.json'))
  writeFileSync(join(dir, '.toolbox-al/config.json'), '{"leaseMinutes":99}')
  initProject(dir)
  assert.equal(JSON.parse(readFileSync(join(dir, '.toolbox-al/config.json'), 'utf8')).leaseMinutes, 99)
})

test('поиск проекта идёт вверх по дереву', () => {
  const dir = tmp()
  initProject(dir)
  mkdirSync(join(dir, 'src/deep'), { recursive: true })
  assert.equal(findProject(join(dir, 'src/deep'))?.root, dir)
})

test('init пишет .gitignore и базу', () => {
  const dir = tmp()
  initProject(dir)
  assert.ok(existsSync(join(dir, '.toolbox-al/tracker.db')))
  assert.match(readFileSync(join(dir, '.gitignore'), 'utf8'), /\.toolbox-al\//)
})

test('вывод init говорит, что настройку делает агент', () => {
  const dir = tmp()
  const text = runInit(dir)
  assert.match(text, /первичную настройку выполняет агент/i)
})
