import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeOpenCodeFiles, writeReviewerAgent, reviewerAgentSource } from '../../src/core/opencode.ts'
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

test('плагин добавляет brainstorming в системный промпт', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  assert.match(plugin, /ctx\.session\.hook\('context'/)
  assert.match(plugin, /Перед любой работой по доске используй brainstorming/)
  assert.match(plugin, /Разговор без глагола работы карточек не создаёт/)
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
  assert.match(read('board-spec'), /«Ран» — board-run/)
  assert.match(read('board-spec'), /«работай» — board-work/)
  assert.match(read('board-spec'), /Тип карточки/)
  assert.match(read('board-spec'), /feat:/)
  assert.match(read('board-spec'), /review:/)
  assert.match(read('board-work'), /Завершил/)
  assert.match(read('board-work'), /Перехожу/)
  assert.match(read('board-work'), /первая карточка забега — без «Завершил»/)
  assert.match(read('board-work'), /это шум/)
  assert.match(read('board-spec'), /reviewRequired/)
  assert.match(read('board-run'), /не больше 3/)
  assert.match(read('board-run'), /только части только что разобранной/)
  assert.match(read('board-run'), /Пакет и проход ревью/)
  assert.match(read('board-run'), /7 находок/)
  assert.match(read('board-run'), /## Ран/)
  assert.match(read('board-run'), /Беру в работу/)
  assert.match(read('board-work'), /Разобрал/)
  assert.match(read('board-work'), /Приступаю/)
})

test('отчёт: шесть моментов и запрет отчёта по вызовам инструментов', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const read = (name: string) =>
    readFileSync(join(root, '.opencode', 'skills', name, 'SKILL.md'), 'utf8')

  const report = `${read('board-work')}\n${read('board-run')}`
  assert.match(report, /Беру в работу/)
  assert.match(report, /Разобрал/)
  assert.match(report, /Приступаю/)
  assert.match(report, /Сдал/)
  assert.match(report, /Снял/)
  assert.match(report, /Забег закрыт/)

  for (const name of ['board-work', 'board-run']) {
    assert.match(read(name), /о каждом вызове инструмента не отчитываться/)
  }
})

test('refresh удаляет старый единый навык board, обычный init — нет', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const legacy = join(root, '.opencode', 'skills', 'board', 'SKILL.md')
  mkdirSync(join(root, '.opencode', 'skills', 'board'), { recursive: true })
  writeFileSync(legacy, '---\nname: board\n---\n', 'utf8')

  writeOpenCodeFiles(root)
  assert.equal(existsSync(legacy), true)

  writeOpenCodeFiles(root, { refresh: true })

  assert.equal(existsSync(legacy), false)
  assert.equal(existsSync(join(root, '.opencode', 'skills', 'board')), false)
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

test('ревьюер не создаёт карточки и пишет итоги в run note', () => {
  const source = reviewerAgentSource('acme/main')
  assert.match(source, /не создавай карточки/i)
  assert.match(source, /board run note/)
  assert.match(source, /7 находок/)
  assert.match(source, /--reviewer/)
  assert.match(source, /--verdict done\|reopen/)
})

test('команда ревью описывает пакет, бюджет и итоги прохода', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const command = readFileSync(join(root, '.opencode', 'command', 'review.md'), 'utf8')
  assert.match(command, /Только читаешь/)
  assert.match(command, /board run note/)
  assert.match(command, /--reviewer/)
  assert.match(command, /7 находок/)
  assert.match(command, /--kind review/)
})

test('AGENTS и board-work описывают ревью пакетом', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  const work = readFileSync(join(root, '.opencode', 'skills', 'board-work', 'SKILL.md'), 'utf8')

  assert.match(agents, /Ревью идёт пакетом/)
  assert.match(agents, /сборник в `deferred`/)
  assert.doesNotMatch(agents, /findings становятся карточками/)

  assert.match(work, /только читает/)
  assert.match(work, /сборник/)
  assert.match(work, /до 3 important/)
})
