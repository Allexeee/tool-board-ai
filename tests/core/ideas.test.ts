import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addIdea, editIdea, getIdea, listIdeas, promoteIdea, realizeIdea, removeIdea, staleIdeas } from '../../src/core/ideas.ts'

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

test('idea edit меняет текст и дату', () => {
  const db = openDb(':memory:')
  const idea = addIdea(db, { text: 'Старое' })

  const edited = editIdea(db, { ideaId: idea.id, text: 'Новое', reviewAt: '2026-12-01', actor: 'owner' })
  assert.equal(edited.text, 'Новое')
  assert.equal(edited.reviewAt, '2026-12-01')
})

test('remove удаляет только непродвинутую идею', () => {
  const db = openDb(':memory:')
  const free = addIdea(db, { text: 'Свободная' })
  removeIdea(db, { ideaId: free.id, actor: 'owner' })
  assert.equal(getIdea(db, free.id), null)

  const promoted = addIdea(db, { text: 'В работу' })
  promoteIdea(db, { ideaId: promoted.id, author: 'owner' })
  assert.throws(() => removeIdea(db, { ideaId: promoted.id, actor: 'owner' }), /запрос/)
})

test('realize прячет идею из списка и сохраняет связь', () => {
  const db = openDb(':memory:')
  const idea = addIdea(db, { text: 'Сделано иначе' })

  realizeIdea(db, { ideaId: idea.id, actor: 'owner' })

  assert.equal(listIdeas(db).some((item) => item.id === idea.id), false)
  assert.equal(listIdeas(db, { all: true }).some((item) => item.id === idea.id), true)
  assert.throws(() => realizeIdea(db, { ideaId: idea.id, actor: 'owner' }), /уже реализована/)
})

test('идея с закрытым запросом считается реализованной', () => {
  const db = openDb(':memory:')
  const idea = addIdea(db, { text: 'Через запрос' })
  const { request } = promoteIdea(db, { ideaId: idea.id, author: 'owner' })

  assert.equal(listIdeas(db).some((item) => item.id === idea.id), true)

  db.prepare("update requests set status = 'closed' where id = ?").run(request.id)
  assert.equal(listIdeas(db).some((item) => item.id === idea.id), false)
})

