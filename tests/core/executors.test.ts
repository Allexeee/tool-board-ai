import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addExecutor, assertSkill, getExecutor, listExecutors, removeExecutor, renameExecutor, setSkills } from '../../src/core/executors.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { takeTask } from '../../src/core/lease.ts'
import { getHand, setHand } from '../../src/core/hands.ts'
import { listEvents } from '../../src/core/events.ts'

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


