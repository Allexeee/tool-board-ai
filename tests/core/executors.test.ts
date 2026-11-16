import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addExecutor, assertSkill, getExecutor } from '../../src/core/executors.ts'

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

test('getExecutor возвращает null для неизвестного', () => {
  const db = openDb(':memory:')
  assert.equal(getExecutor(db, 'nobody'), null)
})
