import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  addDecision,
  listDecisions,
  obsoleteDecision,
  renderDecisions,
  supersedeDecision,
} from '../../src/core/decisions.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

test('addDecision выдаёт D<n> и хранит kind/карточку/автора', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db)

  const d1 = addDecision(board.db, {
    cardId: card.id,
    kind: 'decision',
    text: 'VK API',
    author: 'developer',
  })
  assert.equal(d1.id, 'D1')
  assert.equal(d1.kind, 'decision')
  assert.equal(d1.cardId, card.id)
  assert.equal(d1.status, 'actual')
  assert.equal(d1.author, 'developer')
  assert.equal(d1.supersededBy, null)

  const d2 = addDecision(board.db, { kind: 'assumption', text: 'доступ есть', author: 'owner' })
  assert.equal(d2.id, 'D2')
  assert.equal(d2.kind, 'assumption')
  assert.equal(d2.cardId, null)
})

test('supersede ставит cancelled/superseded_by; render пишет актуальные раньше зачёркнутых', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db)
  const docs = join(board.root, 'docs', 'board')

  const d1 = addDecision(board.db, {
    cardId: card.id,
    kind: 'decision',
    text: 'VK API',
    author: 'developer',
  })
  const d2 = addDecision(board.db, {
    cardId: card.id,
    kind: 'decision',
    text: 'VK закрыт',
    author: 'owner',
  })
  supersedeDecision(board.db, { id: d1.id, by: d2.id, reason: 'нет доступа', actor: 'owner' })

  const cancelled = listDecisions(board.db).find((d) => d.id === d1.id)!
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.supersededBy, d2.id)

  renderDecisions(board.db, docs)
  const md = readFileSync(join(docs, 'decisions.md'), 'utf8')
  assert.match(md, /VK API/)
  assert.match(md, /~~/)
  assert.ok(md.indexOf('VK закрыт') < md.indexOf('VK API'), 'actual first, inactive last')
})

test('obsolete ставит irrelevant', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const d = addDecision(board.db, { kind: 'decision', text: 'старый путь', author: 'owner' })
  obsoleteDecision(board.db, { id: d.id, reason: 'смена платформы', actor: 'owner' })

  const updated = listDecisions(board.db).find((x) => x.id === d.id)!
  assert.equal(updated.status, 'irrelevant')
  assert.equal(updated.supersededBy, null)
})

test('renderDecisions возвращает markdown и пишет файл атомарно', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const docs = join(board.root, 'docs', 'board')

  addDecision(board.db, { kind: 'decision', text: 'один', author: 'owner' })
  const md = renderDecisions(board.db, docs)

  assert.match(md, /один/)
  assert.equal(readFileSync(join(docs, 'decisions.md'), 'utf8'), md)
})
