import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { setHand } from '../../src/core/hands.ts'
import { endRun, startRun } from '../../src/core/runs.ts'
import { createTask } from '../../src/core/tasks.ts'
import { nowView } from '../../src/core/views.ts'
import type { LiveSession } from '../../src/core/usage.ts'

const session = (updatedAt: number): LiveSession => ({
  id: 'ses_test',
  agent: 'worker-1',
  title: 'задача',
  busy: true,
  updatedAt,
})

const worker = (db: ReturnType<typeof openDb>, sessions: LiveSession[] = []) =>
  nowView(db, { sessions }).holders.find((holder) => holder.executor === 'worker-0')!

test('свежий субагент без прогона не делает worker-0 работающим', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'worker-0', kind: 'agent', skills: ['backend'] })

  const fresh = worker(db, [session(Date.now() - 60_000)])
  assert.equal(fresh.working, false, 'субагент работает — это чужая работа, а не работа worker-0')
  assert.deepEqual(fresh.active, [], 'своих задач у worker-0 нет')
  assert.deepEqual(fresh.hand, [], 'рука пуста')

  const stale = worker(db, [session(Date.now() - 60 * 60 * 1000)])
  assert.equal(stale.working, false, 'старый субагент тем более не держит состояние')
})

test('идущий прогон делает worker-0 работающим, даже если субагентов нет', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'worker-0', kind: 'agent', skills: ['backend'] })

  assert.equal(worker(db).working, false, 'без прогона, задач и руки работы нет')

  const run = startRun(db, { mode: 'plan' })
  assert.equal(worker(db).working, true, 'прогон идёт — оркестратор работает')
  assert.equal(worker(db, [session(Date.now() - 60_000)]).working, true, 'свежий субагент при прогоне ничего не ломает')

  endRun(db, { id: run.id, reason: 'owner' })
  assert.equal(worker(db, [session(Date.now() - 60_000)]).working, false, 'прогон закрыт — снова не работает')
})

test('своя задача и своя рука делают worker-0 работающим', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'worker-0', kind: 'agent', skills: ['backend'] })
  const base = {
    dod: ['a'],
    size: 'XS' as const,
    skill: 'backend',
    class: 'standard' as const,
    scope: ['src/core/views.ts'],
  }
  const task = createTask(db, { ...base, title: 'своя задача' })
  const other = createTask(db, { ...base, title: 'задача в руке' })

  db.prepare("update tasks set status = 'active', holder = 'worker-0' where id = ?").run(task.id)
  assert.equal(worker(db).working, true, 'держит свою задачу')

  db.prepare("update tasks set status = 'ready', holder = null where id = ?").run(task.id)
  setHand(db, 'worker-0', [other.id], 'worker-0')
  assert.equal(worker(db).working, true, 'рука не пуста')
})
