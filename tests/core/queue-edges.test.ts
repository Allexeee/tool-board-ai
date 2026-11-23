import test from 'node:test'
import assert from 'node:assert/strict'
import { getCard } from '../../src/core/cards.ts'
import { deferCard, takeCard } from '../../src/core/lifecycle.ts'
import { addStep, listSteps } from '../../src/core/steps.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'

test('defer перенумеровывает очередь без дыр', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const cards = [1, 2, 3].map((position) =>
    seedCard(board.db, { phase: 'task', status: 'ready', position }),
  )

  deferCard(board.db, { id: cards[1].id, actor: 'owner', note: 'позже' })

  const positions = cards
    .filter((card) => card.id !== cards[1].id)
    .map((card) => getCard(board.db, card.id)!.position)
    .sort((left, right) => (left ?? 0) - (right ?? 0))
  assert.deepEqual(positions, [1, 2])
})

test('повторный take не дублирует шаги плана', (t) => {
  const board = makeBoard()
  t.after(board.close)
  seedExecutor(board.db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(board.db, { phase: 'task', status: 'ready' })
  board.db.prepare('update cards set needs_merge = 0, review_required = 1 where id = ?').run(card.id)
  addStep(board.db, { cardId: card.id, text: 'один' })
  addStep(board.db, { cardId: card.id, text: 'два' })

  takeCard(board.db, { id: card.id, actor: 'developer', root: '' })
  assert.throws(
    () => takeCard(board.db, { id: card.id, actor: 'developer', root: '' }),
    /не забронирована|не в работе/,
  )
  assert.equal(listSteps(board.db, card.id).length, 2)
})
