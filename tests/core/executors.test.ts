import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import {
  addExecutor,
  assertSkill,
  DEFAULT_STEPS,
  getExecutor,
  listExecutors,
  parsePermissions,
  removeExecutor,
  renameExecutor,
  setModel,
  setPermissions,
  setSkills,
  setSteps,
} from '../../src/core/executors.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { takeTask } from '../../src/core/lease.ts'
import { getHand, setHand } from '../../src/core/hands.ts'
import { listEvents } from '../../src/core/events.ts'

const lastEvent = (db: ReturnType<typeof openDb>, subject: string) => {
  const events = listEvents(db, { subject })
  return events[events.length - 1]
}

test('исполнитель хранит набор навыков и wip', () => {
  const db = openDb(':memory:')
  const e = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend', 'design'] })
  assert.deepEqual(e.skills, ['backend', 'design'])
  assert.equal(e.wipLimit, 1)
})

test('неизвестный навык даёт понятную ошибку', () => {
  const db = openDb(':memory:')
  const e = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  assert.throws(() => assertSkill(e, 'audio'), /навык audio не найден/)
})

test('повторное добавление того же исполнителя отвергается', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  assert.throws(() => addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] }), /уже есть/)
})

test('добавление исполнителя пишется в журнал', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  assert.equal(listEvents(db, { subject: 'w1' })[0].type, 'executor.added')
})

test('getExecutor возвращает null для неизвестного', () => {
  const db = openDb(':memory:')
  assert.equal(getExecutor(db, 'nobody'), null)
})

test('rename переносит id в задачах и руке', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'old', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    title: 'Правка',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)
  takeTask(db, { executor: 'old', taskId: task.id })
  setHand(db, 'old', [], 'owner')

  const renamed = renameExecutor(db, { from: 'old', to: 'worker-0', actor: 'owner' })

  assert.equal(renamed.id, 'worker-0')
  assert.equal(getTask(db, task.id)!.holder, 'worker-0')
})

test('remove отказывает при активной задаче', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    title: 'Правка',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)
  takeTask(db, { executor: 'w1', taskId: task.id })

  assert.throws(() => removeExecutor(db, { executorId: 'w1', actor: 'owner' }), /активная/)
})

test('remove освобождает руку и удаляет исполнителя', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })
  const task = createTask(db, {
    title: 'Правка',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)
  setHand(db, 'w1', [task.id], 'owner')

  removeExecutor(db, { executorId: 'w1', actor: 'owner' })

  assert.equal(listExecutors(db).length, 0)
  assert.deepEqual(getHand(db, 'w1'), [])
})

test('skills заменяет список', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const updated = setSkills(db, { executorId: 'w1', skills: ['frontend', 'design'], actor: 'owner' })
  assert.deepEqual(updated.skills, ['frontend', 'design'])
})

test('по умолчанию модель наследуется, прав нет, шагов 20', () => {
  const db = openDb(':memory:')
  const e = addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  assert.equal(e.model, null)
  assert.deepEqual(e.permissions, [])
  assert.equal(e.steps, DEFAULT_STEPS)
})

test('add сохраняет модель, права и лимит шагов', () => {
  const db = openDb(':memory:')
  const permissions = parsePermissions({ allow: ['shell:git *'], deny: ['edit:*'] })
  const e = addExecutor(db, {
    id: 'w1',
    kind: 'agent',
    skills: ['backend'],
    model: 'opencode/gpt-5',
    permissions,
    steps: 12,
  })

  assert.equal(e.model, 'opencode/gpt-5')
  assert.equal(e.steps, 12)
  assert.deepEqual(e.permissions, [
    { action: 'shell', resource: 'git *', effect: 'allow' },
    { action: 'edit', resource: '*', effect: 'deny' },
  ])

  const added = lastEvent(db, 'w1')
  assert.equal(added.type, 'executor.added')
  assert.deepEqual(JSON.parse(added.after!), {
    skills: ['backend'],
    kind: 'agent',
    model: 'opencode/gpt-5',
    permissions: e.permissions,
    steps: 12,
  })
})

test('модель без provider/model отвергается', () => {
  const db = openDb(':memory:')

  assert.throws(
    () => addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'], model: 'gpt-5' }),
    /provider\/model/,
  )
  assert.equal(getExecutor(db, 'w1'), null)
})

test('лимит шагов проверяется', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  assert.throws(() => addExecutor(db, { id: 'w2', kind: 'agent', skills: ['backend'], steps: 0 }), /от 1/)
  assert.throws(() => addExecutor(db, { id: 'w3', kind: 'agent', skills: ['backend'], steps: 2.5 }), /целое/)
  assert.throws(() => setSteps(db, { executorId: 'w1', steps: 'x', actor: 'owner' }), /целое/)
})

test('право без action:resource объясняет формат', () => {
  assert.throws(() => parsePermissions({ allow: ['git *'] }), /action:resource/)
  assert.throws(() => parsePermissions({ deny: ['shell:'] }), /пустой ресурс/)
})

test('позже указанное правило побеждает при том же action:resource', () => {
  const permissions = parsePermissions({ allow: ['shell:git *'], deny: ['shell:git *'] })
  assert.deepEqual(permissions, [{ action: 'shell', resource: 'git *', effect: 'deny' }])
})

test('model меняет значение и пишет событие, inherit очищает', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const updated = setModel(db, { executorId: 'w1', model: 'anthropic/claude-sonnet-4-5', actor: 'owner' })
  assert.equal(updated.model, 'anthropic/claude-sonnet-4-5')

  const changed = lastEvent(db, 'w1')
  assert.equal(changed.type, 'executor.model_changed')
  assert.deepEqual(JSON.parse(changed.before!), { model: null })
  assert.deepEqual(JSON.parse(changed.after!), { model: 'anthropic/claude-sonnet-4-5' })

  const cleared = setModel(db, { executorId: 'w1', model: 'inherit', actor: 'owner' })
  assert.equal(cleared.model, null)
})

test('permissions заменяет правила и пишет событие', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const updated = setPermissions(db, {
    executorId: 'w1',
    permissions: parsePermissions({ allow: ['shell:git *'], deny: ['webfetch:*'] }),
    actor: 'owner',
  })

  assert.deepEqual(updated.permissions, [
    { action: 'shell', resource: 'git *', effect: 'allow' },
    { action: 'webfetch', resource: '*', effect: 'deny' },
  ])

  const changed = lastEvent(db, 'w1')
  assert.equal(changed.type, 'executor.permissions_changed')
  assert.deepEqual(JSON.parse(changed.before!), { permissions: [] })
  assert.deepEqual(JSON.parse(changed.after!), { permissions: updated.permissions })
})

test('steps меняет лимит и пишет событие', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const updated = setSteps(db, { executorId: 'w1', steps: 7, actor: 'owner' })
  assert.equal(updated.steps, 7)

  const changed = lastEvent(db, 'w1')
  assert.equal(changed.type, 'executor.steps_changed')
  assert.deepEqual(JSON.parse(changed.before!), { steps: DEFAULT_STEPS })
  assert.deepEqual(JSON.parse(changed.after!), { steps: 7 })
})


