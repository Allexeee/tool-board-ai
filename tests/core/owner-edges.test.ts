import test from 'node:test'
import assert from 'node:assert/strict'
import { getCard } from '../../src/core/cards.ts'
import { amendCard } from '../../src/core/lifecycle.ts'
import { reorderQueue } from '../../src/core/queue.ts'
import { addFinding } from '../../src/core/review.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

test('находка по owner-карточке создаётся как dev-задача', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const owner = seedCard(board.db, { phase: 'task', status: 'ready' })
  board.db.prepare("update cards set skill = 'owner' where id = ?").run(owner.id)

  const finding = addFinding(board.db, {
    cardId: owner.id,
    reviewer: 'reviewer',
    severity: 'other',
    text: 'поправить текст',
  })

  assert.equal(finding.skill, 'dev')
})

test('reorder снимает застрявшую позицию у owner-карточки', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const owner = seedCard(board.db, { phase: 'task', status: 'ready' })
  board.db
    .prepare("update cards set skill = 'owner', position = 5 where id = ?")
    .run(owner.id)

  reorderQueue(board.db)

  assert.equal(getCard(board.db, owner.id)!.position, null)
})

test('amend owner-карточки возвращает в new без держателя и lease', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const owner = seedCard(board.db, { phase: 'task', status: 'ready' })
  board.db
    .prepare(
      "update cards set skill = 'owner', holder = 'owner', lease_until = ?, position = 3 where id = ?",
    )
    .run(new Date(Date.now() + 60_000).toISOString(), owner.id)

  const amended = amendCard(board.db, { id: owner.id, actor: 'owner', reason: 'уточнить' })
  assert.equal(amended.status, 'new')
  assert.equal(amended.holder, null)
  assert.equal(amended.leaseUntil, null)
  assert.equal(amended.position, null)
})
