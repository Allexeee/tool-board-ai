import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import {
  addExecutor,
  DEFAULT_STEPS,
  getExecutor,
  listExecutors,
  renameExecutor,
  setModel,
  setSteps,
  type Executor,
} from '../../src/core/executors.ts'
import {
  AGENTS_DIR,
  agentProblems,
  isAgentId,
  moveAgent,
  removeAgent,
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
  assert.match(text, new RegExp(`^steps: ${DEFAULT_STEPS}$`, 'm'))
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

test('removeAgent убирает файл агента и не трогает соседей', () => {
  const root = tmp()
  const db = openDb(':memory:')
  syncAgent(root, addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] }))
  syncAgent(root, addExecutor(db, { id: 'w2', kind: 'agent', skills: ['frontend'] }))

  const removal = removeAgent(root, 'w1')

  assert.equal(removal.status, 'removed')
  assert.equal(removal.path, `${AGENTS_DIR}/w1.md`)
  assert.equal(removal.warning, undefined)
  assert.equal(existsSync(join(root, AGENTS_DIR, 'w1.md')), false)
  assert.equal(existsSync(join(root, AGENTS_DIR, 'w2.md')), true)
})

test('removeAgent без файла и с недопустимым id ничего не делает', () => {
  const root = tmp()

  assert.deepEqual(removeAgent(root, 'w1'), { id: 'w1', path: '', status: 'absent' })
  assert.deepEqual(removeAgent(root, '../evil'), { id: '../evil', path: '', status: 'absent' })
  assert.equal(existsSync(join(root, AGENTS_DIR)), false)
})

test('сбой удаления файла возвращается предупреждением, а не падением', () => {
  const root = tmp()
  const path = join(root, AGENTS_DIR, 'w1.md')
  mkdirSync(path, { recursive: true })

  const removal = removeAgent(root, 'w1')

  assert.equal(removal.status, 'failed')
  assert.equal(removal.path, `${AGENTS_DIR}/w1.md`)
  assert.match(removal.warning!, /остался/)
  assert.equal(existsSync(path), true, 'файл на месте: базу это не откатывает')
})

test('moveAgent переносит файл: старое имя уходит, новое появляется с текстом из базы', () => {
  const root = tmp()
  const db = openDb(':memory:')
  syncAgent(root, addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] }))

  const renamed = renameExecutor(db, { from: 'w1', to: 'worker-1', actor: 'owner' })
  const move = moveAgent(root, 'w1', renamed)

  assert.equal(move.status, 'moved')
  assert.equal(move.path, `${AGENTS_DIR}/worker-1.md`)
  assert.equal(move.warning, undefined)
  assert.equal(existsSync(join(root, AGENTS_DIR, 'w1.md')), false)
  assert.equal(readFileSync(join(root, AGENTS_DIR, 'worker-1.md'), 'utf8'), renderAgent(renamed))
  assert.match(readFileSync(join(root, AGENTS_DIR, 'worker-1.md'), 'utf8'), /take --as worker-1/)
  assert.deepEqual(agentProblems(root, listExecutors(db)), [])
})

test('moveAgent без старого файла новый не создаёт', () => {
  const root = tmp()
  const executor = worker({ id: 'worker-1' })

  const move = moveAgent(root, 'w1', executor)

  assert.deepEqual(move, { from: 'w1', to: 'worker-1', path: '', status: 'absent' })
  assert.equal(existsSync(join(root, AGENTS_DIR, 'worker-1.md')), false)
})

test('moveAgent доносит предупреждение, если старый файл не удалился', () => {
  const root = tmp()
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const source = join(root, AGENTS_DIR, 'w1.md')
  mkdirSync(source, { recursive: true })

  const renamed = renameExecutor(db, { from: 'w1', to: 'w2', actor: 'owner' })
  const move = moveAgent(root, 'w1', renamed)

  assert.equal(move.status, 'moved')
  assert.equal(move.path, `${AGENTS_DIR}/w2.md`)
  assert.match(move.warning!, /остался/)
  assert.equal(existsSync(join(root, AGENTS_DIR, 'w2.md')), true)
  assert.equal(existsSync(source), true, 'старый файл остался, но перенос состоялся')
})

test('moveAgent людям файл агента не создаёт', () => {
  const root = tmp()
  mkdirSync(join(root, AGENTS_DIR), { recursive: true })
  writeFileSync(join(root, AGENTS_DIR, 'owner.md'), 'чужой файл\n', 'utf8')

  const move = moveAgent(root, 'chief', worker({ id: 'owner', kind: 'human' }))

  assert.equal(move.status, 'absent')
  assert.equal(readFileSync(join(root, AGENTS_DIR, 'owner.md'), 'utf8'), 'чужой файл\n')
})

const bin = resolve('bin/toolbox-al.ts')

function cli(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8' })
  return { code: result.status, out: result.stdout, err: result.stderr }
}

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'al-agents-cli-'))
  assert.equal(cli(dir, ['init']).code, 0)
  assert.equal(cli(dir, ['executor', 'add', 'w1', '--skills', 'backend']).code, 0)
  assert.equal(cli(dir, ['executor', 'sync', 'w1']).code, 0)
  return dir
}

const agentFile = (dir: string, id: string) => join(dir, AGENTS_DIR, `${id}.md`)

test('executor remove убирает файл агента', () => {
  const dir = project()

  const removed = cli(dir, ['executor', 'remove', 'w1'])

  assert.equal(removed.code, 0, removed.err)
  assert.match(removed.out, /w1 удалён/)
  assert.match(removed.out, /файл агента удалён: \.opencode\/agents\/w1\.md/)
  assert.equal(existsSync(agentFile(dir, 'w1')), false)
  assert.equal(removed.err, '')
})

test('executor rename переносит файл и ставит новое имя в текст', () => {
  const dir = project()

  const renamed = cli(dir, ['executor', 'rename', 'w1', 'worker-1'])

  assert.equal(renamed.code, 0, renamed.err)
  assert.match(renamed.out, /w1 → worker-1/)
  assert.match(renamed.out, /\.opencode\/agents\/w1\.md → \.opencode\/agents\/worker-1\.md/)
  assert.equal(existsSync(agentFile(dir, 'w1')), false)
  const text = readFileSync(agentFile(dir, 'worker-1'), 'utf8')
  assert.match(text, /^description: "исполнитель worker-1 · навыки: backend"$/m)
  assert.match(text, /take --as worker-1/)
  assert.doesNotMatch(text, /w1/)
})

test('executor rename не отменяется сбоем удаления файла', () => {
  const dir = project()
  rmSync(agentFile(dir, 'w1'))
  mkdirSync(agentFile(dir, 'w1'), { recursive: true })

  const renamed = cli(dir, ['executor', 'rename', 'w1', 'w2'])

  assert.equal(renamed.code, 0, renamed.err)
  assert.match(renamed.out, /w1 → w2/)
  assert.match(renamed.err, /внимание: файл \.opencode\/agents\/w1\.md остался/)
  assert.equal(existsSync(agentFile(dir, 'w2')), true)
  assert.match(readFileSync(agentFile(dir, 'w2'), 'utf8'), /take --as w2/)

  const listed = JSON.parse(cli(dir, ['executor', '--json']).out)
  assert.deepEqual(listed.map((executor: { id: string }) => executor.id), ['w2'])
})
