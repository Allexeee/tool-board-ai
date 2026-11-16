import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { mergePoolTasks, poolTasks, removePoolTask, stalePoolTasks } from '../../src/core/pool.ts'

const base = {
  title: 'Поправить опечатку',
  dod: ['опечатки нет'],
  size: 'XS' as const,
  skill: 'backend',
  class: 'quick' as const,
  scope: ['docs/**'],
}

test('задача пула видна и стареет', () => {
  const db = openDb(':memory:')
  createTask(db, { ...base })

  assert.equal(poolTasks(db).length, 1)
  assert.equal(stalePoolTasks(db, 7).length, 0)
  assert.equal(stalePoolTasks(db, -1).length, 1)
})

test('remove закрывает задачу с причиной и пишет событие', () => {
  const db = openDb(':memory:')
  createTask(db, { ...base })

  const task = removePoolTask(db, { taskId: 'T1', actor: 'owner', reason: 'не актуально' })
  assert.equal(task.status, 'cancelled')
  assert.equal(getTask(db, 'T1')!.reason, 'не актуально')

  const event = db.prepare("select type from events where subject = 'T1' order by id desc limit 1").get() as {
    type: string
  }
  assert.equal(event.type, 'pool.removed')
})

test('remove без причины отвергается', () => {
  const db = openDb(':memory:')
  createTask(db, { ...base })
  assert.throws(() => removePoolTask(db, { taskId: 'T1', actor: 'owner', reason: ' ' }), /причина/)
})

test('merge переносит DoD и отменяет источник', () => {
  const db = openDb(':memory:')
  createTask(db, { ...base })
  createTask(db, { ...base, title: 'Второе', dod: ['второе условие'] })

  const target = mergePoolTasks(db, { from: 'T2', to: 'T1', actor: 'owner' })

  assert.deepEqual(target.dod, ['опечатки нет', 'второе условие'])
  assert.equal(getTask(db, 'T2')!.status, 'cancelled')
})

test('merge с собой отвергается', () => {
  const db = openDb(':memory:')
  createTask(db, { ...base })
  assert.throws(() => mergePoolTasks(db, { from: 'T1', to: 'T1', actor: 'owner' }), /с собой/)
})
