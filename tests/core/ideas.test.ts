import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addIdea, listIdeas, promoteIdea, staleIdeas } from '../../src/core/ideas.ts'

test('идея повышается до запроса один раз', () => {
  const db = openDb(':memory:')
  const idea = addIdea(db, { text: 'экспорт в CSV' })
  const { request } = promoteIdea(db, { ideaId: idea.id, author: 'owner' })

  assert.equal(request.title, 'экспорт в CSV')
  assert.equal(listIdeas(db)[0].promotedTo, request.id)
})

test('повторное повышение отвергается', () => {
  const db = openDb(':memory:')
  const idea = addIdea(db, { text: 'x' })
  promoteIdea(db, { ideaId: idea.id, author: 'owner' })
  assert.throws(() => promoteIdea(db, { ideaId: idea.id, author: 'owner' }), /уже/)
})

test('идея без даты пересмотра попадает в забытые', () => {
  const db = openDb(':memory:')
  addIdea(db, { text: 'старая идея' })
  assert.equal(staleIdeas(db, 0).length, 1)
  assert.equal(listIdeas(db).length, 1)
})
