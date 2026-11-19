import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpenCodeFiles } from '../../src/core/opencode.ts'
import { initProject } from '../../src/core/project.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'board-oc-'))

test('initProject создаёт скилл, плагин, команду ревью и блок в AGENTS.md', () => {
  const { created, root } = initProject(tmp())
  assert.ok(existsSync(join(root, '.opencode', 'skills', 'board', 'SKILL.md')))
  assert.ok(existsSync(join(root, '.opencode', 'plugins', 'board', 'index.ts')))
  assert.ok(existsSync(join(root, '.opencode', 'command', 'review.md')))
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /board/)
  assert.ok(created.some((p) => p.includes('SKILL.md')))
})

test('скилл ссылается на terminology.md и на порядок работы', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = readFileSync(join(root, '.opencode', 'skills', 'board', 'SKILL.md'), 'utf8')
  assert.match(skill, /terminology\.md/)
  assert.match(skill, /board now/)
  assert.match(skill, /card shape/)
  assert.match(skill, /review list/)
})

test('плагин объявляет инструмент board_now и зовёт CLI', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  assert.match(plugin, /board_now/)
  assert.match(plugin, /board\.ts/)
  assert.match(plugin, /BOARD_CLI/)
  assert.match(plugin, /Plugin\.define/)
})

test('команда ревью упоминает review list и review submit', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const command = readFileSync(join(root, '.opencode', 'command', 'review.md'), 'utf8')
  assert.match(command, /review list/)
  assert.match(command, /review submit/)
  assert.match(command, /review finding/)
})

test('writeOpenCodeFiles идемпотентен: второй вызов ничего не создаёт', () => {
  const root = tmp()
  const first = writeOpenCodeFiles(root)
  assert.ok(first.created.length >= 4)

  const second = writeOpenCodeFiles(root)
  assert.deepEqual(second.created, [])
})

test('существующий AGENTS.md сохраняется, блок board добавляется', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const path = join(root, 'AGENTS.md')

  // перезапись блока между маркерами сохраняет текст вокруг
  const withEdit = '# Мой проект\n\n<!-- board:begin -->\nстарое\n<!-- board:end -->\n\nхвост\n'
  writeFileSync(path, withEdit, 'utf8')

  writeOpenCodeFiles(root)

  const after = readFileSync(path, 'utf8')
  assert.match(after, /Мой проект/)
  assert.match(after, /хвост/)
  assert.match(after, /node bin\/board\.ts/)
  assert.doesNotMatch(after, /старое/)
})
