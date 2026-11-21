import test from 'node:test'
import assert from 'node:assert/strict'
import { editCard, getCard } from '../../src/core/cards.ts'
import { approveCard, shapeCard, submitCard } from '../../src/core/lifecycle.ts'
import {
  assertSpecReview,
  latestSpecReview,
  recordSpecReview,
} from '../../src/core/spec-review.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

function shapingCard(db: Board['db']) {
  const card = seedCard(db)
  shapeCard(db, { id: card.id, actor: 'developer' })
  editCard(db, {
    id: card.id,
    actor: 'developer',
    patch: {
      body: 'Нужен вход',
      acceptance: ['Вход работает'],
      importance: 2,
      urgency: 2,
      scope: ['src/**'],
    },
  })
  return getCard(db, card.id)!
}

const isDecision = (error: { code?: number }) => error.code === 2
const isInput = (error: { code?: number }) => error.code === 3

test('spec review записывается с kind, mode, spec_rev и вердиктом', (t) => {
  const { db } = board(t)
  const card = shapingCard(db)

  const review = recordSpecReview(db, {
    cardId: card.id,
    reviewer: 'developer',
    mode: 'self',
    verdict: 'done',
    note: 'полно',
  })

  assert.equal(review.kind, 'spec')
  assert.equal(review.mode, 'self')
  assert.equal(review.verdict, 'done')
  assert.equal(review.specRev, card.specRev)
  assert.equal(review.note, 'полно')
  assert.deepEqual(latestSpecReview(db, card.id), review)
})

test('spec review требует shaping, spec и acceptance', (t) => {
  const { db } = board(t)
  const fresh = seedCard(db)
  assert.throws(
    () => recordSpecReview(db, { cardId: fresh.id, reviewer: 'developer', mode: 'self', verdict: 'done' }),
    isInput,
  )

  shapeCard(db, { id: fresh.id, actor: 'developer' })
  assert.throws(
    () => recordSpecReview(db, { cardId: fresh.id, reviewer: 'developer', mode: 'self', verdict: 'done' }),
    /spec/,
  )
  editCard(db, { id: fresh.id, actor: 'developer', patch: { body: 'spec' } })
  assert.throws(
    () => recordSpecReview(db, { cardId: fresh.id, reviewer: 'developer', mode: 'self', verdict: 'done' }),
    /критери/,
  )
})

test('gate none не требует review, self требует done на текущей версии', (t) => {
  const { db } = board(t)
  const card = shapingCard(db)
  assert.doesNotThrow(() => assertSpecReview(db, card, { mode: 'none', reviewerModel: null }))

  assert.throws(
    () => assertSpecReview(db, card, { mode: 'self', reviewerModel: null }),
    isDecision,
  )
  recordSpecReview(db, { cardId: card.id, reviewer: 'developer', mode: 'self', verdict: 'done' })
  const reviewed = getCard(db, card.id)!
  assert.doesNotThrow(() => assertSpecReview(db, reviewed, { mode: 'self', reviewerModel: null }))

  const stale = editCard(db, { id: card.id, actor: 'developer', patch: { body: 'новый spec' } })
  assert.throws(
    () => assertSpecReview(db, stale, { mode: 'self', reviewerModel: null }),
    isDecision,
  )
})

test('subagent gate: self не подходит, без модели ошибка', (t) => {
  const { db } = board(t)
  const card = shapingCard(db)
  recordSpecReview(db, { cardId: card.id, reviewer: 'developer', mode: 'self', verdict: 'done' })

  assert.throws(
    () => assertSpecReview(db, card, { mode: 'subagent', reviewerModel: 'acme/model' }),
    isDecision,
  )
  assert.throws(
    () => assertSpecReview(db, card, { mode: 'subagent', reviewerModel: null }),
    isDecision,
  )

  recordSpecReview(db, { cardId: card.id, reviewer: 'reviewer', mode: 'subagent', verdict: 'done' })
  assert.doesNotThrow(() =>
    assertSpecReview(db, card, { mode: 'subagent', reviewerModel: 'acme/model' }),
  )
})

test('submitCard принимает requiredSpecReview и не пускает без review', (t) => {
  const { db } = board(t)
  const card = shapingCard(db)
  const gate = { mode: 'self' as const, reviewerModel: null }

  assert.throws(() => submitCard(db, { id: card.id, actor: 'developer', requiredSpecReview: gate }), isDecision)

  recordSpecReview(db, { cardId: card.id, reviewer: 'developer', mode: 'self', verdict: 'done' })
  const submitted = submitCard(db, { id: card.id, actor: 'developer', requiredSpecReview: gate })
  assert.equal(submitted.status, 'approval')
})

test('approveCard проверяет review текущей версии', (t) => {
  const { db } = board(t)
  const card = shapingCard(db)
  const gate = { mode: 'self' as const, reviewerModel: null }
  recordSpecReview(db, { cardId: card.id, reviewer: 'developer', mode: 'self', verdict: 'done' })
  submitCard(db, { id: card.id, actor: 'developer', requiredSpecReview: gate })

  db.prepare("update cards set body = 'другой spec', spec_rev = spec_rev + 1 where id = ?").run(card.id)
  assert.throws(
    () => approveCard(db, { id: card.id, actor: 'owner', requiredSpecReview: gate }),
    isDecision,
  )
})
