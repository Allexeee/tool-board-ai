import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { addRoutine } from '../../src/core/routines.ts'
import { addGate, checkGate, getGate, satisfyGate, resetGate } from '../../src/core/gates.ts'
import { addRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage } from '../../src/core/stages.ts'
import { makeRepo } from '../helpers/repo.ts'

function fixture() {
  const db = openDb(':memory:')
  const routine = addRoutine(db, { name: 'R', schedule: 'daily 09:00' })
  const root = makeRepo()
  return { db, routine, root }
}

test('capability-гейт ждёт слияния этапа', () => {
  const { db, routine, root } = fixture()
  const request = addRequest(db, { title: 'A', body: '', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'A', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })

  const gate = addGate(db, { routineId: routine.id, kind: 'capability', name: stage.id })
  assert.equal(checkGate(db, gate, { root }).ok, false)

  db.prepare("update stages set status = 'merged' where id = ?").run(stage.id)
  assert.equal(checkGate(db, gate, { root }).ok, true)
})

test('check-гейт запускает команду', () => {
  const { db, routine, root } = fixture()
  const gate = addGate(db, {
    routineId: routine.id,
    kind: 'check',
    name: 'main',
    payload: 'git rev-parse --verify refs/heads/main',
  })
  assert.equal(checkGate(db, gate, { root }).ok, true)

  const broken = addGate(db, {
    routineId: routine.id,
    kind: 'check',
    name: 'nope',
    payload: 'git rev-parse --verify refs/heads/nope',
  })
  assert.equal(checkGate(db, broken, { root }).ok, false)
})

test('approval once закрывается навсегда', () => {
  const { db, routine, root } = fixture()
  const gate = addGate(db, { routineId: routine.id, kind: 'approval', name: 'first', once: true })
  assert.equal(checkGate(db, gate, { root }).ok, false)

  satisfyGate(db, { gateId: gate.id, actor: 'owner' })
  assert.equal(checkGate(db, getGate(db, gate.id)!, { root }).ok, true)

  resetGate(db, { gateId: gate.id, actor: 'owner' })
  assert.equal(checkGate(db, getGate(db, gate.id)!, { root }).ok, false)
})

test('неизвестный вид гейта отвергается', () => {
  const { db, routine } = fixture()
  assert.throws(
    () => addGate(db, { routineId: routine.id, kind: 'magic' as never, name: 'x' }),
    /вид/,
  )
})

void mkdtempSync(join(tmpdir(), 'unused-'))
