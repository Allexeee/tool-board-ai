import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpenCodeFiles, writeReviewerAgent } from '../../src/core/opencode.ts'
import { initProject } from '../../src/core/project.ts'
import { DEFAULT_SETTINGS } from '../../src/core/settings.ts'

process.env.BOARD_ALLOW_GLOBAL = '1'

const tmp = () => mkdtempSync(join(tmpdir(), 'board-oc-'))

test('initProject создаёт четыре навыка, плагин, команды и блок в AGENTS.md', () => {
  const { created, root } = initProject(tmp())
  for (const name of ['board-spec', 'board-work', 'board-run', 'board-now']) {
    assert.ok(existsSync(join(root, '.opencode', 'skills', name, 'SKILL.md')), name)
  }
  assert.equal(existsSync(join(root, '.opencode', 'skills', 'board', 'SKILL.md')), false)
  assert.ok(existsSync(join(root, '.opencode', 'plugins', 'board', 'index.ts')))
  assert.ok(existsSync(join(root, '.opencode', 'command', 'review.md')))
  assert.ok(existsSync(join(root, '.opencode', 'command', 'setup.md')))
  assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /board/)
  assert.ok(created.some((p) => p.includes('SKILL.md')))
})

test('навыки ссылаются на terminology.md и на порядок работы', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const read = (name: string) =>
    readFileSync(join(root, '.opencode', 'skills', name, 'SKILL.md'), 'utf8')
  assert.match(read('board-spec'), /terminology\.md/)
  assert.match(read('board-spec'), /card shape/)
  assert.match(read('board-now'), /board now/)
  assert.match(read('board-work'), /review list/)
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

test('плагин поднимается из .worktrees в корень', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  assert.match(plugin, /basename\(dirname\(dir\)\) === '\.worktrees'/)
  assert.match(plugin, /dirname\(dirname\(dir\)\)/)
})

test('четыре навыка: разные description и свои правила', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const read = (name: string) =>
    readFileSync(join(root, '.opencode', 'skills', name, 'SKILL.md'), 'utf8')

  const descriptions = ['board-spec', 'board-work', 'board-run', 'board-now'].map((name) => {
    const line = read(name).split('\n').find((item) => item.startsWith('description:'))
    assert.ok(line, name)
    return line
  })
  assert.equal(new Set(descriptions).size, 4)

  assert.match(read('board-spec'), /без глагола работы/i)
  assert.match(read('board-spec'), /reviewRequired/)
  assert.match(read('board-run'), /не больше 3/)
  assert.match(read('board-run'), /только части только что разобранной/)
  assert.match(read('board-work'), /Разобрал/)
  assert.match(read('board-work'), /Приступаю/)
})

test('refresh удаляет старый единый навык board', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const legacy = join(root, '.opencode', 'skills', 'board', 'SKILL.md')
  mkdirSync(join(root, '.opencode', 'skills', 'board'), { recursive: true })
  writeFileSync(legacy, '---\nname: board\n---\n', 'utf8')

  writeOpenCodeFiles(root, { refresh: true })

  assert.equal(existsSync(legacy), false)
})

test('разговор у brainstorming, исполнение Native: навыки и AGENTS без правил разговора', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const skill = ['board-spec', 'board-work', 'board-run', 'board-now']
    .map((name) => readFileSync(join(root, '.opencode', 'skills', name, 'SKILL.md'), 'utf8'))
    .join('\n')
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')

  for (const text of [skill, agents]) {
    assert.match(text, /brainstorming/i)
    assert.match(text, /docs\/superpowers/)
    assert.match(text, /Native/)
    assert.doesNotMatch(text, /subagent-driven|subagent driven/i)
  }

  assert.match(skill, /spec и критерии приёмки идут в карточку/)
  assert.match(skill, /отдельного plan-файла нет/)
  assert.match(skill, /асинхронный вопрос/)
  assert.match(skill, /только если без ответа нельзя продолжать/)
  assert.match(agents, /асинхронный вопрос/)
  assert.match(agents, /без субагентов-исполнителей/)
})

test('card схема принимает verdict для spec-review', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  const start = plugin.indexOf("name: 'card'")
  const end = plugin.indexOf("name: 'run'", start)
  assert.ok(start > 0 && end > start)
  assert.match(plugin.slice(start, end), /verdict: \{ type: 'string' \}/)
})
