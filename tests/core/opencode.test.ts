import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpenCodeFiles, writeReviewerAgent } from '../../src/core/opencode.ts'
import { initProject } from '../../src/core/project.ts'
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts'

process.env.BOARD_ALLOW_GLOBAL = '1'

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

test('плагин ищет tools/board раньше BOARD_CLI и не зовёт глобальный board', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  const local = plugin.indexOf("'tools', 'board'")
  const override = plugin.indexOf('process.env.BOARD_CLI')
  assert.ok(local > 0)
  assert.ok(local < override)
  assert.doesNotMatch(plugin, /file: 'board'/)
  assert.match(plugin, /board не установлен/)
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

test('reviewer agent берёт effective-модель сессии, если настройка пуста', () => {
  const root = tmp()
  writeOpenCodeFiles(root, {
    settings: DEFAULT_SETTINGS,
    context: { variant: 'max', sessionModel: 'acme/main#max' },
  })
  const agent = readFileSync(join(root, '.opencode', 'agents', 'board-reviewer.md'), 'utf8')
  assert.match(agent, /model: acme\/main/)
  assert.doesNotMatch(agent, /#max|#high/)
})

test('reviewer agent создаётся с default-моделью и удаляется без неё', () => {
  const root = tmp()
  const settings = {
    ...DEFAULT_SETTINGS,
    reviewer: { model: 'opencode-go/deepseek-v4.1-flash' },
  }
  writeOpenCodeFiles(root, { settings })
  const path = join(root, '.opencode', 'agents', 'board-reviewer.md')
  const agent = readFileSync(path, 'utf8')
  assert.match(agent, /mode: subagent/)
  assert.match(agent, /model: opencode-go\/deepseek-v4\.1-flash/)
  assert.doesNotMatch(agent, /#max|#high/)

  writeReviewerAgent(root, { ...settings, reviewer: { model: null } }, true)
  assert.equal(existsSync(path), false)
})

test('spec-review и review команды — оркестраторы с plan/acceptance', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const spec = readFileSync(join(root, '.opencode', 'command', 'spec-review.md'), 'utf8')
  const review = readFileSync(join(root, '.opencode', 'command', 'review.md'), 'utf8')
  assert.match(spec, /subagent: false/)
  assert.match(spec, /card spec-review/)
  assert.match(spec, /specReview\.mode/)
  assert.match(review, /subagent: false/)
  assert.match(review, /--plan done\|failed/)
  assert.match(review, /acceptance|критери/)
  assert.match(review, /board-reviewer/)
})

test('команда setup описывает режимы ревьюеров', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const command = readFileSync(join(root, '.opencode', 'command', 'setup.md'), 'utf8')
  assert.match(command, /board setup --show/)
  assert.match(command, /--spec-review/)
  assert.match(command, /--large-spec/)
  assert.match(command, /--run-review/)
  assert.match(command, /--reviewer-model/)
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

test('проект подключает superpowers локально', () => {
  const config = JSON.parse(
    readFileSync(join(process.cwd(), '.opencode', 'opencode.json'), 'utf8'),
  ) as { plugins?: string[] }
  assert.ok(config.plugins?.some((entry) => entry.includes('superpowers')))
})

test('плагин поднимается из .worktrees в корень', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  assert.match(plugin, /basename\(dirname\(dir\)\) === '\.worktrees'/)
  assert.match(plugin, /dirname\(dirname\(dir\)\)/)
})
