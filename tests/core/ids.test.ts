import test from 'node:test'
import assert from 'node:assert/strict'
import { allocateGroupId, allocateId } from '../../src/core/ids.ts'
import { makeBoard } from '../helpers/board.ts'

test('групповые ID растут внутри группы и не переиспользуются', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  assert.equal(allocateGroupId(db, 'UI'), 'UI-1')
  assert.equal(allocateGroupId(db, 'UI'), 'UI-2')
  assert.equal(allocateGroupId(db, 'IM'), 'IM-1')
  assert.equal(allocateGroupId(db, 'ui'), 'UI-3')
})

test('префикс группы проверяется', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  assert.throws(() => allocateGroupId(db, 'ui/tool'), /префикс/)
  assert.throws(() => allocateGroupId(db, ''), /префикс/)
  assert.throws(() => allocateGroupId(db, 'TOOLONGID'), /префикс/)
})

test('служебные ID идут из счётчиков meta', (t) => {
  const { db, close } = makeBoard()
  t.after(close)

  assert.equal(allocateId(db, 'run'), 'RUN-1')
  assert.equal(allocateId(db, 'run'), 'RUN-2')
  assert.equal(allocateId(db, 'decision'), 'D1')
  assert.equal(allocateId(db, 'decision'), 'D2')

  assert.equal(db.prepare("select value from meta where key = 'counter.run'").get()?.value, '2')
  assert.equal(db.prepare("select value from meta where key = 'counter.decision'").get()?.value, '2')
})
