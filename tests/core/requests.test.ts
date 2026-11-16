import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest, editRequest } from '../../src/core/requests.ts'

test('правка запроса меняет текст и пишет before/after', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: 'старый текст', author: 'owner' })

  const updated = editRequest(db, { id: request.id, title: 'Оплата подписки', body: 'новый текст', actor: 'owner' })
  assert.equal(updated.title, 'Оплата подписки')
  assert.equal(updated.body, 'новый текст')

  const event = db
    .prepare("select before, after from events where type = 'request.edited' order by id desc limit 1")
    .get() as { before: string; after: string }
  assert.match(event.before, /старый текст/)
  assert.match(event.after, /новый текст/)
})

test('правка несуществующего запроса отвергается', () => {
  const db = openDb(':memory:')
  assert.throws(() => editRequest(db, { id: 'R99', title: 'x', actor: 'owner' }), /не найден/)
})
