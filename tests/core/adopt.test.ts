import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildAdoptPlan, renderAdoptPlan } from '../../src/core/adopt.ts'
import { addGroup, listGroups } from '../../src/core/groups.ts'
import { readSettings, updateSettings } from '../../src/core/settings.ts'
import { listExecutors } from '../../src/core/executors.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'

const NO_MODEL = { variant: null, sessionModel: null }

test('adopt --check: пустой проект получает план и ничего не меняет', (t) => {
  const board = makeBoard()
  t.after(board.close)
  mkdirSync(join(board.root, 'docs', 'inbox'), { recursive: true })
  writeFileSync(join(board.root, 'docs', 'inbox', 'task.md'), '# Починить вход\n')

  const before = readFileSync(join(board.root, '.board', 'settings.json'), 'utf8')
  const counts = () =>
    ['cards', 'events', 'tags', 'groups'].map(
      (table) => (board.db.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n,
    )
  const beforeCounts = counts()
  const plan = buildAdoptPlan(board.db, board.root, NO_MODEL)

  assert.deepEqual(plan.groups.missing.map((group) => group.prefix), ['CARD'])
  assert.deepEqual(plan.executors.missing.map((executor) => executor.id), ['developer'])
  assert.equal(plan.profile.configured, 'auto')
  assert.equal(plan.profile.effective, 'auto → default (вариант неизвестен)')
  assert.equal(plan.acceptance.existing.length, 0)
  assert.deepEqual(plan.acceptance.suggested, [])
  assert.match(plan.acceptance.prompt ?? '', /Напишите критерии/)
  assert.equal(plan.acceptance.examples.length, 2)
  assert.deepEqual(
    plan.tags.suggested.map((tag) => tag.name),
    ['ui', 'backend', 'docs', 'test'],
  )
  assert.deepEqual(plan.sources.map((source) => source.title), ['feat: Починить вход'])
  assert.equal(plan.backlog.exists, false)
  assert.equal(plan.required, 2)
  assert.ok(plan.remaining > 0)

  assert.deepEqual(listGroups(board.db), [])
  assert.deepEqual(listExecutors(board.db).map((executor) => executor.id), ['owner'])
  assert.equal(readFileSync(join(board.root, '.board', 'settings.json'), 'utf8'), before)
  assert.deepEqual(counts(), beforeCounts)

  const again = buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.deepEqual(again, plan)
})

test('adopt --check: после применения шагов остаток уменьшается, дублей нет', (t) => {
  const board = makeBoard()
  t.after(board.close)

  addGroup(board.db, { prefix: 'CARD', name: 'Общие задачи', actor: 'developer' })
  seedExecutor(board.db)
  updateSettings(board.root, {
    acceptance: {
      rules: [{ name: 'документация', include: { paths: ['docs/**', 'README.md'] } }],
    },
  })
  mkdirSync(join(board.root, 'docs', 'inbox'), { recursive: true })
  writeFileSync(join(board.root, 'docs', 'inbox', 'task.md'), '# Починить вход\n')

  const plan = buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.deepEqual(plan.groups.missing, [])
  assert.deepEqual(plan.executors.missing, [])
  assert.deepEqual(plan.acceptance.suggested, [])
  assert.equal(plan.required, 0)
  assert.deepEqual(plan.sources.map((source) => source.path), ['docs/inbox/task.md'])

  const source = plan.sources[0]
  seedCard(board.db, {
    group: source.group,
    title: source.title,
    skill: 'dev',
  })

  const after = buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.deepEqual(after.sources, [])
  assert.ok(after.remaining < plan.remaining)
  assert.deepEqual(buildAdoptPlan(board.db, board.root, NO_MODEL), after)
})

test('adopt --check: auto показывает эффективный профиль и меняется с моделью', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const low = buildAdoptPlan(board.db, board.root, { variant: 'low', sessionModel: null })
  const high = buildAdoptPlan(board.db, board.root, { variant: 'high', sessionModel: null })
  assert.equal(low.profile.effective, 'auto → low')
  assert.equal(high.profile.effective, 'auto → high')
  assert.equal(high.profile.findings, 'critical+important')

  updateSettings(board.root, { review: { profile: 'custom' } })
  const custom = buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.equal(custom.profile.configured, 'custom')
  assert.equal(custom.profile.effective, 'custom')
  assert.equal(custom.profile.command, null)
  assert.match(custom.profile.note, /вариант модели неизвестен/)
  assert.equal(
    custom.steps.some((step) => step.area === 'profile'),
    false,
  )

  const known = buildAdoptPlan(board.db, board.root, { variant: 'max', sessionModel: null })
  assert.equal(known.profile.command, 'board setup --profile auto --model-variant max')
  assert.ok(known.steps.some((step) => step.area === 'profile'))
})

test('adopt --check: существующая карточка не дублирует задачу из inbox', (t) => {
  const board = makeBoard()
  t.after(board.close)
  addGroup(board.db, { prefix: 'CARD', name: null, actor: 'owner' })
  mkdirSync(join(board.root, 'docs', 'inbox'), { recursive: true })
  writeFileSync(join(board.root, 'docs', 'inbox', 'task.md'), '# Починить вход\n')
  seedCard(board.db, { group: 'CARD', title: 'fix: Починить вход', skill: 'owner' })

  const plan = buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.deepEqual(plan.sources, [])
})

test('adopt --check: чеклист вне inbox тоже источник задачи', (t) => {
  const board = makeBoard()
  t.after(board.close)
  mkdirSync(join(board.root, 'docs', 'release'), { recursive: true })
  writeFileSync(join(board.root, 'docs', 'release', 'checklist.md'), '# Проверить релиз\n')

  const plan = buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.deepEqual(plan.sources.map((source) => source.path), ['docs/release/checklist.md'])
})

test('adopt --check: источник получает навык исполнителя, а не его id', (t) => {
  const board = makeBoard()
  t.after(board.close)
  addGroup(board.db, { prefix: 'CARD', name: null, actor: 'owner' })
  seedExecutor(board.db, { id: 'developer', skills: ['dev', 'frontend'] })
  mkdirSync(join(board.root, 'docs', 'inbox'), { recursive: true })
  writeFileSync(join(board.root, 'docs', 'inbox', 'task.md'), '# Починить вход\n')

  const plan = buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.equal(plan.sources[0].skill, 'dev')
  assert.match(plan.sources[0].command, /--skill "dev"/)
  assert.doesNotMatch(plan.sources[0].command, /--skill "developer"/)
})

test('adopt --check: команды источников не дают shell-подстановку', (t) => {
  const board = makeBoard()
  t.after(board.close)
  addGroup(board.db, { prefix: 'CARD', name: null, actor: 'owner' })
  mkdirSync(join(board.root, 'docs', 'inbox'), { recursive: true })
  writeFileSync(
    join(board.root, 'docs', 'inbox', 'task.md'),
    '# Закрыть $(rm -rf /) `id` "x"\n',
  )

  const source = buildAdoptPlan(board.db, board.root, NO_MODEL).sources[0]
  assert.match(source.command, /Закрыть/)
  assert.doesNotMatch(source.command, /\$\(|`|\$[A-Za-z_]/)
  assert.doesNotMatch(source.command, /\\/)
})

test('adopt --check: ## и front matter дают заголовок; README и шаблоны пропускаются', (t) => {
  const board = makeBoard()
  t.after(board.close)
  addGroup(board.db, { prefix: 'CARD', name: null, actor: 'owner' })
  const inbox = join(board.root, 'docs', 'inbox')
  mkdirSync(inbox, { recursive: true })
  writeFileSync(join(inbox, 'README.md'), '# Индекс входящих\n')
  writeFileSync(join(inbox, '_template.md'), '# Шаблон\n')
  writeFileSync(
    join(inbox, 'task.md'),
    '---\ntitle: метаданные\n---\n\n## Настоящая задача\n\nтекст\n',
  )

  const plan = buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.deepEqual(plan.sources.map((source) => source.path), ['docs/inbox/task.md'])
  assert.deepEqual(plan.sources.map((source) => source.title), ['feat: Настоящая задача'])
})

test('renderAdoptPlan: остаток и честная пометка, что доска ничего не создала', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const plan = buildAdoptPlan(board.db, board.root, NO_MODEL)
  const text = renderAdoptPlan(plan)
  assert.match(text, /План обновления доски/)
  assert.match(text, /Осталось шагов: \d+/)
  assert.match(text, /Доска ничего не создала/)
  assert.match(text, /board group add CARD/)
  assert.match(text, /Напишите критерии/)
  assert.equal(text.match(/•/g)?.length, 2)
})

test('settings не содержат правил после чтения плана', (t) => {
  const board = makeBoard()
  t.after(board.close)
  buildAdoptPlan(board.db, board.root, NO_MODEL)
  assert.deepEqual(readSettings(board.root).acceptance.rules, [])
})
