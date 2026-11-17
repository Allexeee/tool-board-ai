import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import {
  addExecutor,
  getExecutor,
  listExecutors,
  setModel,
  setSteps,
  type Executor,
} from '../../src/core/executors.ts'
import {
  AGENTS_DIR,
  agentProblems,
  isAgentId,
  renderAgent,
  syncAgent,
  syncAgents,
} from '../../src/core/agents.ts'

const tmp = () => mkdtempSync(join(tmpdir(), 'al-agents-'))

function worker(overrides: Partial<Parameters<typeof addExecutor>[1]> = {}): Executor {
  const db = openDb(':memory:')
  return addExecutor(db, {
    id: 'w1',
    kind: 'agent',
    skills: ['backend', 'design'],
    model: 'opencode/gpt-5',
    steps: 12,
    permissions: [{ action: 'shell', resource: 'git *', effect: 'allow' }],
    ...overrides,
  })
}

test('файл агента несёт описание, модель, права и лимит шагов', () => {
  const text = renderAgent(worker())

  assert.match(text, /^---\n/)
  assert.match(text, /^description: "исполнитель w1 · навыки: backend, design"$/m)
  assert.match(text, /^mode: subagent$/m)
  assert.match(text, /^model: opencode\/gpt-5$/m)
  assert.match(text, /^steps: 12$/m)
  assert.match(text, /^permissions:\n {2}- action: shell\n {4}resource: "git \*"\n {4}effect: allow$/m)
  assert.match(text, /---\n\nТы — исполнитель w1/)
  assert.match(text, /take --as w1/)
  assert.ok(text.endsWith('\n'), 'файл заканчивается переводом строки')
})

test('без модели поле model не пишется: агент наследует модель родителя', () => {
  const text = renderAgent(worker({ model: null }))

  assert.doesNotMatch(text, /^model:/m)
  assert.match(text, /^mode: subagent$/m)
})

test('без прав остаётся пустой список, а шаги берутся по умолчанию', () => {
  const text = renderAgent(worker({ permissions: [], steps: undefined }))

  assert.match(text, /^permissions: \[\]$/m)
  assert.match(text, /^steps: 20$/m)
})

test('непригодный для имени файла id отвергается с объяснением', () => {
  assert.equal(isAgentId('w1'), true)
  assert.equal(isAgentId('worker-2'), true)
  assert.equal(isAgentId('../evil'), false)
  assert.throws(() => renderAgent(worker({ id: '../evil' })), /не годится для имени файла/)
})

test('sync создаёт .opencode/agents/<id>.md с текстом из базы', () => {
  const root = tmp()
  const executor = worker()

  const result = syncAgent(root, executor)

  assert.equal(result.status, 'created')
  assert.equal(result.path, `${AGENTS_DIR}/w1.md`)
  assert.equal(readFileSync(join(root, AGENTS_DIR, 'w1.md'), 'utf8'), renderAgent(executor))
})

test('повторный sync при неизменной базе не трогает файл', () => {
  const root = tmp()
  const executor = worker()
  syncAgent(root, executor)
  const path = join(root, AGENTS_DIR, 'w1.md')
  const before = statSync(path).mtimeMs
  const content = readFileSync(path, 'utf8')

  const again = syncAgent(root, executor)

  assert.equal(again.status, 'unchanged')
  assert.equal(statSync(path).mtimeMs, before, 'mtime не менялся')
  assert.equal(readFileSync(path, 'utf8'), content)
})

test('изменение модели, прав или шагов переписывает файл', () => {
  const root = tmp()
  const db = openDb(':memory:')
  const executor = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  syncAgent(root, executor)

  setSteps(db, { executorId: 'w1', steps: 7, actor: 'owner' })
  const stepped = syncAgent(root, getExecutor(db, 'w1')!)

  assert.equal(stepped.status, 'updated')
  assert.match(readFileSync(join(root, stepped.path), 'utf8'), /^steps: 7$/m)

  setModel(db, { executorId: 'w1', model: 'anthropic/claude-sonnet-4-5', actor: 'owner' })
  const modeled = syncAgent(root, getExecutor(db, 'w1')!)

  assert.equal(modeled.status, 'updated')
  assert.match(readFileSync(join(root, modeled.path), 'utf8'), /^model: anthropic\/claude-sonnet-4-5$/m)
})

test('сверка видит пропавший файл, правку руками и расхождение с базой', () => {
  const root = tmp()
  const db = openDb(':memory:')
  const executor = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const missing = agentProblems(root, [executor])
  assert.deepEqual(missing.map((problem) => problem.status), ['missing'])

  syncAgent(root, executor)
  assert.deepEqual(agentProblems(root, listExecutors(db)), [])

  writeFileSync(join(root, AGENTS_DIR, 'w1.md'), 'правка руками\n', 'utf8')
  assert.deepEqual(agentProblems(root, listExecutors(db)).map((problem) => problem.status), ['drift'])

  syncAgent(root, executor)
  setSteps(db, { executorId: 'w1', steps: 3, actor: 'owner' })
  assert.deepEqual(agentProblems(root, listExecutors(db)).map((problem) => problem.status), ['drift'])
})

test('сверка не падает, когда каталога агентов ещё нет', () => {
  const root = tmp()
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  assert.equal(existsSync(join(root, AGENTS_DIR)), false)
  assert.deepEqual(
    agentProblems(root, listExecutors(db)).map((problem) => problem.id),
    ['w1'],
  )
})

test('люди файла агента не получают', () => {
  const root = tmp()
  const db = openDb(':memory:')
  addExecutor(db, { id: 'owner', kind: 'human', skills: [] })

  assert.deepEqual(syncAgents(root, listExecutors(db)), [])
  assert.deepEqual(agentProblems(root, listExecutors(db)), [])
  assert.equal(existsSync(join(root, AGENTS_DIR)), false)
})

test('sync без id проходит по всем агентам и не задевает людей', () => {
  const root = tmp()
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  addExecutor(db, { id: 'w2', kind: 'agent', skills: ['frontend'] })
  addExecutor(db, { id: 'owner', kind: 'human', skills: [] })

  const results = syncAgents(root, listExecutors(db))

  assert.deepEqual(results.map((result) => [result.id, result.status]), [
    ['w1', 'created'],
    ['w2', 'created'],
  ])
  assert.equal(existsSync(join(root, AGENTS_DIR, 'owner.md')), false)
})
