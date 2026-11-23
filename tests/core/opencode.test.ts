import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  assert.match(plugin, /windowsHide: true/)
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

test('плагин держит правила отчёта в системном промпте', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = pluginSource(root)
  const start = plugin.indexOf("ctx.session.hook('context'")
  const end = plugin.indexOf('ctx.tool.transform')
  assert.ok(start > 0 && end > start)
  const hook = plugin.slice(start, end)

  for (const rule of [
    'Беру в работу',
    'Приступаю к {ID}',
    'Сделал {ID}',
    'Перехожу к {ID}',
    'только «Сделал»',
    'Завершил {RUN}',
    'Ревью ожидают задачи',
    'если в review что-то есть',
    'Ревью сейчас или до релиза?',
    'если очередь не пуста',
    'до следующего вызова инструмента',
    'не заменяет',
    'не пиши',
  ]) {
    assert.ok(hook.includes(rule), rule)
  }
})

test('навыки говорят, когда продлевать lease', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const read = (name: string) =>
    readFileSync(join(root, '.opencode', 'skills', name, 'SKILL.md'), 'utf8')
  assert.match(read('board-work'), /touch/)
  assert.match(read('board-run'), /touch/)
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

function pluginSource(root: string): string {
  return readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
}

/** Вырезает функцию из сгенерированного плагина: он не импортируется в тестах. */
function extractFunction(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `нет функции ${name}`)
  const rest = source.slice(start)
  const end = rest.search(/\n}\r?\n/)
  assert.ok(end > 0, `нет конца функции ${name}`)
  return rest.slice(0, end + 2)
}

function buildArgs(source: string, name: string): (input: Record<string, unknown>) => string[] {
  const code = `${extractFunction(source, 'flag')}\n${extractFunction(source, name)}\nreturn ${name}`
  return new Function(code)() as (input: Record<string, unknown>) => string[]
}

test('плагин собирает аргументы подкоманд карточки', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const cardArgs = buildArgs(pluginSource(root), 'cardArgs')

  assert.deepEqual(cardArgs({ action: 'step', sub: 'add', id: 'UI-1', text: 'шаг' }), [
    'card', 'step', 'add', 'UI-1', 'шаг',
  ])
  assert.deepEqual(cardArgs({ action: 'step', sub: 'done', id: 'UI-1', index: 2 }), [
    'card', 'step', 'done', 'UI-1', '2',
  ])
  assert.deepEqual(
    cardArgs({ action: 'ref', sub: 'add', id: 'UI-1', kind: 'doc', value: 'docs/x.md', title: 't' }),
    ['card', 'ref', 'add', 'UI-1', '--kind', 'doc', '--value', 'docs/x.md', '--title', 't'],
  )
  assert.deepEqual(cardArgs({ action: 'dep', sub: 'add', id: 'UI-1', other: 'UI-2' }), [
    'card', 'dep', 'add', 'UI-1', 'UI-2',
  ])
  assert.deepEqual(cardArgs({ action: 'scope', sub: 'add', id: 'UI-1', paths: ['a.ts', 'b.ts'] }), [
    'card', 'scope', 'add', 'UI-1', 'a.ts', 'b.ts',
  ])
  assert.deepEqual(cardArgs({ action: 'defer', id: 'UI-1', note: 'n', as: 'owner' }), [
    'card', 'defer', 'UI-1', '--note', 'n', '--as', 'owner',
  ])
  assert.deepEqual(cardArgs({ action: 'resume', id: 'UI-1', as: 'owner' }), [
    'card', 'resume', 'UI-1', '--as', 'owner',
  ])
})

test('плагин собирает аргументы run note, очереди и бэкапа', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const source = pluginSource(root)

  assert.deepEqual(buildArgs(source, 'runArgs')({ action: 'note', id: 'RUN-1', text: 'итоги', as: 'reviewer' }), [
    'run', 'note', 'RUN-1', '--text', 'итоги', '--as', 'reviewer',
  ])
  assert.deepEqual(buildArgs(source, 'queueArgs')({ action: 'move', id: 'UI-4', before: 'UI-2' }), [
    'queue', 'move', 'UI-4', '--before', 'UI-2',
  ])
  assert.deepEqual(buildArgs(source, 'queueArgs')({ action: 'move', id: 'UI-4', top: true }), [
    'queue', 'move', 'UI-4', '--top',
  ])
  assert.deepEqual(buildArgs(source, 'queueArgs')({ action: 'reorder' }), ['queue', 'reorder'])
  assert.deepEqual(buildArgs(source, 'backupArgs')({ action: 'export', format: 'md' }), [
    'export', '--format', 'md',
  ])
  assert.deepEqual(buildArgs(source, 'backupArgs')({ action: 'backup' }), ['backup'])
  assert.deepEqual(buildArgs(source, 'backupArgs')({ action: 'backup', out: 'C:/x.db' }), [
    'backup', 'C:/x.db',
  ])
})

test('плагин передаёт в card add приоритеты, scope, теги и note', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const args = buildArgs(pluginSource(root), 'cardArgs')({
    action: 'add',
    group: 'UI',
    title: 't',
    spec: 's',
    acceptance: ['a'],
    tags: ['new'],
    importance: 2,
    urgency: 3,
    scope: ['src/**'],
    needs_merge: false,
    review: true,
    note: 'n',
    skill: 'dev',
    as: 'owner',
  })

  for (const pair of [
    ['--tag', 'new'],
    ['--importance', '2'],
    ['--urgency', '3'],
    ['--scope', 'src/**'],
    ['--no-needs-merge', null],
    ['--review', null],
    ['--note', 'n'],
  ]) {
    if (pair[1] === null) {
      assert.ok(args.includes(pair[0]), pair[0])
    } else {
      assert.equal(args[args.indexOf(pair[0]) + 1], pair[1], pair[0])
    }
  }
})

test('плагин: sub обязателен, run list компактен, код 1/2 не ошибка', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const source = pluginSource(root)

  assert.match(source, /нужен sub: add\|done\|remove\|list/)
  assert.match(source, /runRow/)
  assert.match(source, /status >= 3/)
  assert.match(source, /'touch'.*\[.id., .as.\]|schema\(\{ id: \{ type: 'string' \}, as: \{ type: 'string' \} \}, \['id', 'as'\]\)/)
})

test('плагин объявляет tool-ы touch, doctor, backup, release, queue', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = pluginSource(root)

  for (const name of ['queue', 'touch', 'doctor', 'backup', 'release']) {
    assert.match(plugin, new RegExp(`name: '${name}'`), name)
  }
  assert.match(plugin, /name: 'run'/)
  assert.match(plugin, /a === 'note'/)
  assert.match(plugin, /input\.as !== 'owner'/)
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
  assert.match(spec, /board card submit/)
  assert.match(spec, /При `reopen` submit не делай/)
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
  for (const kind of ['feat:', 'fix:', 'perf:', 'sec:', 'docs:', 'test:', 'chore:', 'review:']) {
    assert.match(read('board-spec'), new RegExp(kind), kind)
  }
  assert.match(read('board-work'), /Сделал \{ID\}/)
  assert.match(read('board-work'), /Перехожу/)
  assert.match(read('board-work'), /две строки/)
  assert.match(read('board-work'), /Перехожу к \{ID\}/)
  assert.match(read('board-run'), /Завершил \{RUN\}/)
  assert.match(read('board-run'), /1\. \{ID\}/)
  assert.match(read('board-run'), /Ревью ожидают задачи/)
  assert.match(read('board-run'), /если в `review` что-то есть/)
  assert.match(read('board-run'), /Ревью сейчас или до релиза\?/)
  assert.match(read('board-run'), /если очередь не пуста/)
  assert.match(read('board-run'), /Следующий Run/)
  assert.match(read('board-run'), /Запустить следующий Run\?/)
  assert.match(read('board-work'), /первая карточка забега — без «Сделал»/)
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
  assert.match(report, /Сделал/)
  assert.match(report, /Снял/)
  assert.match(report, /Завершил \{RUN\}/)

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

test('board-work: целевые тесты на карточке, полный прогон перед релизом', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const work = readFileSync(join(root, '.opencode', 'skills', 'board-work', 'SKILL.md'), 'utf8')
  assert.match(work, /целевые тесты/)
  assert.match(work, /bump-карточки перед релизом/)
  assert.match(work, /настройки, жизненный цикл, git-слой/)
  assert.doesNotMatch(work, /перед `run end`/)
  assert.doesNotMatch(work, /node --test` и `tsc/)

  const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8')
  assert.match(readme, /повторный — только дельта/)
  assert.match(readme, /finding-карточка/)
  assert.doesNotMatch(readme, /до 3 important/)
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
  assert.match(command, /только дельта/)
})

test('AGENTS и board-work описывают ревью пакетом', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8')
  const work = readFileSync(join(root, '.opencode', 'skills', 'board-work', 'SKILL.md'), 'utf8')

  assert.match(agents, /Ревью идёт пакетом/)
  assert.match(agents, /сборник в `deferred`/)
  assert.match(agents, /finding-карточка/)
  assert.doesNotMatch(agents, /findings становятся карточками/)

  assert.match(work, /только читает/)
  assert.match(work, /сборник/)
  assert.match(work, /только дельта/)
  assert.match(work, /important — finding-карточка/)
  assert.doesNotMatch(work, /до 3 important/)
})


test('сгенерированный плагин синтаксически валиден', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const plugin = readFileSync(join(root, '.opencode', 'plugins', 'board', 'index.ts'), 'utf8')
  const copy = join(root, 'plugin-check.mjs')
  writeFileSync(copy, plugin, 'utf8')
  const result = spawnSync(process.execPath, ['--check', copy], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
})

test('плагин сокращает карточку до id, статуса и ветки', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const compactCard = new Function(`${extractFunction(pluginSource(root), 'compactCard')}; return compactCard`)()
  const card = {
    id: 'UI-1', status: 'review', title: 'x', body: 'b', acceptance: 'a',
    branch: 'card/UI-1', position: 3, scope: ['src/**'],
  }
  assert.deepEqual(compactCard(card), {
    id: 'UI-1', status: 'review', branch: 'card/UI-1', position: 3,
  })
  assert.deepEqual(compactCard([card]), [{
    id: 'UI-1', status: 'review', branch: 'card/UI-1', position: 3,
  }])
  const step = { seq: 1, text: 'шаг', done: false }
  assert.deepEqual(compactCard(step), step)
})

test('плагин сокращает now и list, show остаётся полным', () => {
  const root = tmp()
  writeOpenCodeFiles(root)
  const source = pluginSource(root)
  const compactNow = new Function(
    `${extractFunction(source, 'cardRow')}\n${extractFunction(source, 'isCard')}\n${extractFunction(source, 'stripHeavy')}\n${extractFunction(source, 'compactNow')}\nreturn compactNow`,
  )()
  const big = {
    id: 'CORE-21',
    status: 'done',
    title: 't',
    skill: 'dev',
    group: 'CORE',
    holder: 'developer',
    body: 'big',
    acceptance: 'a',
    scope: ['src/**'],
    steps: [{ seq: 1, text: 's' }],
    summary: 's',
    branch: 'card/CORE-21',
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  const row = { id: 'CORE-21', status: 'done', title: 't', skill: 'dev', group: 'CORE', holder: 'developer' }
  const now = {
    view: 1,
    header: { doneToday: 2, lastDone: [big] },
    cards: [big],
    ownerCards: [big],
    approvals: [big],
    queue: [big],
    requests: [big],
    executors: [{ id: 'developer', cards: [big] }],
    probableRuns: [{ id: 'RUN-1', cards: [{ card: big, status: 'planned' }] }],
    deferredCount: 1,
  }
  const compacted = compactNow(now)
  assert.equal(compacted.view, 1)
  assert.equal(compacted.header.doneToday, 2)
  assert.equal(compacted.deferredCount, 1)
  assert.deepEqual(compacted.header.lastDone[0], row)
  assert.deepEqual(compacted.cards[0], row)
  assert.deepEqual(compacted.ownerCards[0], row)
  assert.deepEqual(compacted.approvals[0], row)
  assert.deepEqual(compacted.queue[0], row)
  assert.deepEqual(compacted.requests[0], row)
  assert.deepEqual(compacted.executors[0].cards[0], row)
  assert.deepEqual(compacted.probableRuns[0].cards[0].card, row)
  assert.equal(compacted.probableRuns[0].cards[0].status, 'planned')

  const serialized = JSON.stringify(compacted)
  for (const heavy of ['"body"', '"acceptance"', '"scope"', '"steps"', '"summary"', '"branch"']) {
    assert.equal(serialized.includes(heavy), false, heavy)
  }

  assert.match(source, /withJson/)
  assert.match(source, /if \(input\.action === 'show'\) return result/)
  assert.match(source, /compactNow/)
})
