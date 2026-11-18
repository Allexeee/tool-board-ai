import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { nowView } from '../../src/core/views.ts'
import type { LiveSession } from '../../src/core/usage.ts'

const session = (updatedAt: number): LiveSession => ({
  id: 'ses_test',
  agent: 'worker-1',
  title: 'задача',
  busy: true,
  updatedAt,
})

test('worker-0 работает, пока его субагент работал недавно', () => {
  const db = openDb(':memory:')
  addExecutor(db, { id: 'worker-0', kind: 'agent', skills: ['backend'] })

  const fresh = nowView(db, { sessions: [session(Date.now() - 60_000)] })
  assert.equal(fresh.holders[0]!.working, true, 'свежий субагент — оркестратор работает')

  const stale = nowView(db, { sessions: [session(Date.now() - 60 * 60 * 1000)] })
  assert.equal(stale.holders[0]!.working, false, 'старый субагент не держит состояние')
})
