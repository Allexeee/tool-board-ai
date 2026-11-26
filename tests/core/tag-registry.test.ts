import test from 'node:test'
import assert from 'node:assert/strict'
import {
  addTag,
  assertKnownTags,
  listTags,
  removeTag,
  renameTag,
} from '../../src/core/tags.ts'
import { getCard } from '../../src/core/cards.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

test('реестр тегов: add, list, rename обновляет карточки', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const tag = addTag(board.db, { name: 'UI', description: 'интерфейс', actor: 'owner' })
  assert.equal(tag.name, 'ui')
  const card = seedCard(board.db, { tags: ['ui'] })
  assert.equal(listTags(board.db).find((item) => item.name === 'ui')?.count, 1)

  const renamed = renameTag(board.db, { from: 'ui', to: 'interface', actor: 'owner' })
  assert.equal(renamed.name, 'interface')
  assert.deepEqual(getCard(board.db, card.id)!.tags, ['interface'])
  assert.equal(listTags(board.db).some((item) => item.name === 'ui'), false)
})

test('реестр тегов: занятый и служебный тег не удаляются', (t) => {
  const board = makeBoard()
  t.after(board.close)

  addTag(board.db, { name: 'ui' })
  const card = seedCard(board.db, { tags: ['ui'] })
  assert.throws(() => removeTag(board.db, { name: 'ui' }), /занят/)

  const cleared = board.db
    .prepare("update cards set tags = '[]' where id = ?")
    .run(card.id)
  assert.equal(cleared.changes, 1)
  assert.equal(removeTag(board.db, { name: 'ui' }).name, 'ui')
  assert.throws(() => removeTag(board.db, { name: 'new' }), /служебный/)
})

test('assertKnownTags нормализует и отвергает неизвестный тег', (t) => {
  const board = makeBoard()
  t.after(board.close)

  addTag(board.db, { name: 'ui' })
  assert.deepEqual(assertKnownTags(board.db, [' UI ', 'ui']), ['ui'])
  assert.throws(() => assertKnownTags(board.db, ['nope']), /не найден/)
})
