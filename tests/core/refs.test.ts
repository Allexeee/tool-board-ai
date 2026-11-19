import test from 'node:test'
import assert from 'node:assert/strict'
import { createCard } from '../../src/core/cards.ts'
import { listEvents } from '../../src/core/events.ts'
import { addRef, listRefs, removeRef } from '../../src/core/refs.ts'
import { makeBoard } from '../helpers/board.ts'

function makeCardBoard(t: { after: (fn: () => void) => void }) {
  const board = makeBoard()
  t.after(board.close)
  const card = createCard(board.db, {
    group: 'UI',
    title: 'x',
    skill: 'dev',
    author: 'owner',
  })
  return { db: board.db, card }
}

test('addRef сохраняет вид, значение, заголовок и время', (t) => {
  const { db, card } = makeCardBoard(t)

  const ref = addRef(db, {
    cardId: card.id,
    kind: 'spec',
    value: 'docs/specs/login.md',
    title: 'Спека логина',
  })

  assert.equal(typeof ref.id, 'number')
  assert.equal(ref.cardId, card.id)
  assert.equal(ref.kind, 'spec')
  assert.equal(ref.value, 'docs/specs/login.md')
  assert.equal(ref.title, 'Спека логина')
  assert.match(ref.createdAt, /^\d{4}-\d{2}-\d{2}T/)
})

test('addRef принимает все три вида и пустой заголовок', (t) => {
  const { db, card } = makeCardBoard(t)

  const link = addRef(db, { cardId: card.id, kind: 'link', value: '  https://example.com  ' })
  const doc = addRef(db, { cardId: card.id, kind: 'doc', value: 'docs/board/x.md', title: '   ' })

  assert.equal(link.value, 'https://example.com')
  assert.equal(link.title, null)
  assert.equal(doc.kind, 'doc')
  assert.equal(doc.title, null)
  assert.deepEqual(
    listRefs(db, card.id).map((ref) => ref.kind),
    ['link', 'doc'],
  )
})

test('addRef пишет событие в журнал', (t) => {
  const { db, card } = makeCardBoard(t)

  addRef(db, { cardId: card.id, kind: 'spec', value: 'docs/spec.md', actor: 'developer' })

  const events = listEvents(db, card.id)
  assert.equal(events.at(-1)!.type, 'ref.added')
  assert.equal(events.at(-1)!.actor, 'developer')
})

test('removeRef удаляет ссылку по номеру', (t) => {
  const { db, card } = makeCardBoard(t)
  const first = addRef(db, { cardId: card.id, kind: 'link', value: 'https://a' })
  addRef(db, { cardId: card.id, kind: 'link', value: 'https://b' })

  const removed = removeRef(db, { cardId: card.id, id: first.id })

  assert.equal(removed.value, 'https://a')
  assert.deepEqual(
    listRefs(db, card.id).map((ref) => ref.value),
    ['https://b'],
  )
})

test('refs проверяют вид, значение, карточку и номер', (t) => {
  const { db, card } = makeCardBoard(t)

  assert.throws(
    () => addRef(db, { cardId: card.id, kind: 'video' as never, value: 'x' }),
    /kind/,
  )
  assert.throws(() => addRef(db, { cardId: card.id, kind: 'link', value: '  ' }), /значение/)
  assert.throws(() => addRef(db, { cardId: 'UI-9', kind: 'link', value: 'x' }), /не найдена/)
  assert.throws(() => removeRef(db, { cardId: card.id, id: 42 }), /не найдена/)
})
