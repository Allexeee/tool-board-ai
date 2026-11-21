import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpenCodeFiles } from '../../src/core/opencode.ts'
import { initProject } from '../../src/core/project.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'board-oc-'))

test('initProject создаёт скилл, плагин, команды и блок в AGENTS.md', () => {
  const { created, root } = initProject(tmp())
  assert.ok(existsSync(join(root, '.opencode', 'skills', 'board', 'SKILL.md')))
  assert.ok(existsSync(join(root, '.opencode', 'plugins', 'board', 'index.ts')))
  assert.ok(existsSync(join(root, '.opencode', 'command', 'review.md')))
  assert.ok(existsSync(join(root, '.opencode', 'command', 'setup.md')))
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

test('плагин объявляет board_now и board_setup и зовёт CLI', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  assert.match(plugin, /board_now/)
  assert.match(plugin, /board_setup/)
  assert.match(plugin, /name: 'setup'/)
  assert.match(plugin, /'setup', '--show'/)
  assert.match(plugin, /review-after-run/)
  assert.match(plugin, /no-review-after-run/)
  assert.match(plugin, /board\.ts/)
  assert.match(plugin, /BOARD_CLI/)
  assert.match(plugin, /Plugin\.define/)
  assert.match(plugin, /error\.stdout\?\.trim\(\)\s*\|\|\s*error\.stderr\?\.trim\(\)\s*\|\|\s*error\.message/)
})

test('команда ревью упоминает review list и review submit', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const command = readFileSync(join(root, '.opencode', 'command', 'review.md'), 'utf8')
  assert.match(command, /review list/)
  assert.match(command, /review submit/)
  assert.match(command, /review finding/)
})

test('плагин передаёт модель сессии в CLI', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  assert.match(plugin, /ctx\.session\.get/)
  assert.match(plugin, /context\.sessionID/)
  assert.match(plugin, /BOARD_MODEL_VARIANT/)
  assert.match(plugin, /BOARD_SESSION_MODEL/)
  assert.match(plugin, /execute: \(input, context\)/)
  assert.match(plugin, /name: 'setup'/)
  assert.match(plugin, /reviewer-model/)
  assert.match(plugin, /spec-review/)
  assert.match(plugin, /amend/)
  assert.match(plugin, /plan/)
})

test('команда setup показывает и переключает ревью после забега', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const command = readFileSync(join(root, '.opencode', 'command', 'setup.md'), 'utf8')
  assert.match(command, /board setup --show/)
  assert.match(command, /--review-after-run/)
  assert.match(command, /--no-review-after-run/)
})

test('writeOpenCodeFiles идемпотентен: второй вызов ничего не создаёт', () => {
  const root = tmp()
  const first = writeOpenCodeFiles(root)
  assert.ok(first.created.length >= 5)
  assert.deepEqual(first.updated, [])

  const second = writeOpenCodeFiles(root)
  assert.deepEqual(second.created, [])
  assert.deepEqual(second.updated, [])
})

test('writeOpenCodeFiles обновляет сгенерированные файлы только с refresh', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = join(root, '.opencode', 'plugins', 'board', 'index.ts')
  writeFileSync(plugin, '// старый плагин\n', 'utf8')

  const skipped = writeOpenCodeFiles(root)
  assert.deepEqual(skipped.updated, [])
  assert.equal(readFileSync(plugin, 'utf8'), '// старый плагин\n')

  const refreshed = writeOpenCodeFiles(root, { refresh: true })
  assert.ok(refreshed.updated.some((path) => path.includes('plugins/board/index.ts')))
  assert.match(readFileSync(plugin, 'utf8'), /board_setup/)
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
  assert.match(after, /board/)
  assert.doesNotMatch(after, /старое/)
})
