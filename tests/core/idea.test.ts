import test from 'node:test'
import assert from 'node:assert/strict'
import { IDEA_TAG, addIdea, dropIdea, editIdea, listIdeas } from '../../src/core/cards.ts'
import { makeBoard } from '../helpers/board.ts'

test('идея — карточка IDEA вне мержа, ревью и очереди', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const idea = addIdea(board.db, { text: 'Сделать тёмную тему', actor: 'owner' })
  assert.equal(idea.group, 'IDEA')
  assert.equal(idea.status, 'deferred')
  assert.equal(idea.skill, 'owner')
  assert.equal(idea.needsMerge, false)
  assert.equal(idea.reviewRequired, false)
  assert.ok(idea.tags.includes(IDEA_TAG))
  assert.equal(idea.body, 'Сделать тёмную тему')
  assert.equal(idea.title, 'Сделать тёмную тему')
  assert.equal(idea.position, null)

  assert.deepEqual(listIdeas(board.db).map((card) => card.id), [idea.id])
  const types = (
    board.db.prepare('select type from events where subject = ? order by id').all(idea.id) as Array<{
      type: string
    }>
  ).map((row) => row.type)
  assert.deepEqual(types, ['card.created', 'idea.added'])
})

test('idea edit меняет текст и заголовок, drop отменяет', (t) => {
  const board = makeBoard()
  t.after(board.close)

  const idea = addIdea(board.db, { text: 'Первая строка\nподробности', actor: 'owner' })
  assert.equal(idea.title, 'Первая строка')

  const edited = editIdea(board.db, {
    id: idea.id,
    text: 'Новый текст',
    title: 'Новый заголовок',
    actor: 'owner',
  })
  assert.equal(edited.body, 'Новый текст')
  assert.equal(edited.title, 'Новый заголовок')

  const dropped = dropIdea(board.db, { id: idea.id, actor: 'owner' })
  assert.equal(dropped.status, 'cancelled')
  assert.deepEqual(listIdeas(board.db), [])
})

test('идея не карточка доски: в очередь не встаёт', (t) => {
  const board = makeBoard()
  t.after(board.close)
  addIdea(board.db, { text: 'Идея', actor: 'owner' })

  const queued = board.db
    .prepare("select count(*) as n from cards where position is not null")
    .get() as { n: number }
  assert.equal(queued.n, 0)
})
