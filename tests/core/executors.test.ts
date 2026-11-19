import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addExecutor,
  getExecutor,
  listExecutors,
  removeExecutor,
  updateExecutor,
} from '../../src/core/executors.ts'
import { createCard } from '../../src/core/cards.ts'
import { listEvents } from '../../src/core/events.ts'
import { makeBoard, seedExecutor } from '../helpers/board.ts'

test('addExecutor заводит исполнителя с размером забега по умолчанию', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  seedExecutor(db)

  const developer = getExecutor(db, 'developer')!
  assert.deepEqual(developer.skills, ['dev'])
  assert.equal(developer.kind, 'agent')
  assert.equal(developer.runSize, 3)
  assert.equal(developer.worktree, null)
  assert.equal(developer.lastSeen, null)

  assert.throws(
    () => addExecutor(db, { id: 'developer', kind: 'agent', skills: ['dev'] }),
    /уже/,
  )
  assert.throws(() => removeExecutor(db, 'owner'), /owner/)
})

test('addExecutor проверяет id, kind, навыки и размер забега', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  assert.throws(() => addExecutor(db, { id: '', kind: 'agent', skills: ['dev'] }), /id/)
  assert.throws(() => addExecutor(db, { id: 'bad id', kind: 'agent', skills: ['dev'] }), /id/)
  assert.throws(
    () => addExecutor(db, { id: 'robot', kind: 'robot' as 'agent', skills: ['dev'] }),
    /kind/,
  )
  assert.throws(() => addExecutor(db, { id: 'empty', kind: 'agent', skills: [] }), /навык/)
  assert.throws(() => addExecutor(db, { id: 'blank', kind: 'agent', skills: ['  '] }), /навык/)

  for (const runSize of [0, 4, 2.5]) {
    assert.throws(
      () => addExecutor(db, { id: `size-${runSize}`, kind: 'agent', skills: ['dev'], runSize }),
      /забег/,
      `runSize ${runSize}`,
    )
  }

  assert.equal(getExecutor(db, 'empty'), null)
  assert.equal(getExecutor(db, 'blank'), null)
})

test('навыки тримятся и дубликаты схлопываются', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  const executor = addExecutor(db, {
    id: 'developer',
    kind: 'agent',
    skills: [' dev ', 'dev', 'ui'],
  })

  assert.deepEqual(executor.skills, ['dev', 'ui'])
})

test('updateExecutor меняет навыки и размер забега', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  addExecutor(db, { id: 'developer', kind: 'agent', skills: ['dev'] })
  addExecutor(db, { id: 'marketer', kind: 'agent', skills: ['marketing'] })

  const updated = updateExecutor(db, {
    id: 'developer',
    patch: { skills: ['dev', 'frontend'], runSize: 2 },
  })
  assert.deepEqual(updated.skills, ['dev', 'frontend'])
  assert.equal(updated.runSize, 2)

  const untouched = updateExecutor(db, { id: 'marketer', patch: {} })
  assert.deepEqual(untouched.skills, ['marketing'])
  assert.equal(untouched.runSize, 3)

  assert.throws(
    () => updateExecutor(db, { id: 'nobody', patch: { runSize: 2 } }),
    /не найден/,
  )
  assert.throws(
    () => updateExecutor(db, { id: 'developer', patch: { skills: [] } }),
    /навык/,
  )
  assert.throws(
    () => updateExecutor(db, { id: 'developer', patch: { runSize: 4 } }),
    /забег/,
  )
})

test('removeExecutor отказывает владельцу и исполнителю с карточками', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  addExecutor(db, { id: 'developer', kind: 'agent', skills: ['dev'] })
  const card = createCard(db, {
    group: 'UI',
    title: 'Форма входа',
    skill: 'dev',
    author: 'owner',
  })
  db.prepare('update cards set holder = ? where id = ?').run('developer', card.id)

  assert.throws(() => removeExecutor(db, 'developer'), /держит/)
  assert.equal(getExecutor(db, 'developer')?.id, 'developer')

  db.prepare('update cards set holder = null where id = ?').run(card.id)
  const removed = removeExecutor(db, 'developer')

  assert.equal(removed.id, 'developer')
  assert.equal(getExecutor(db, 'developer'), null)
  assert.deepEqual(
    listEvents(db, 'developer').map((event) => event.type),
    ['executor.added', 'executor.removed'],
  )
})

test('listExecutors отдаёт владельца и добавленных по id', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  addExecutor(db, { id: 'developer', kind: 'agent', skills: ['dev'] })
  addExecutor(db, { id: 'marketer', kind: 'agent', skills: ['marketing'] })

  assert.deepEqual(
    listExecutors(db).map((executor) => executor.id),
    ['developer', 'marketer', 'owner'],
  )
})
