import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest, editRequest, mergeRequests, getRequest, removeRequest, splitRequest } from '../../src/core/requests.ts'
import { addFeature } from '../../src/core/features.ts'
import { addPlan, approvePlan } from '../../src/core/plans.ts'

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

test('merge склеивает текст и закрывает второй запрос', () => {
  const db = openDb(':memory:')
  const first = addRequest(db, { title: 'Оплата', body: 'карты', author: 'owner' })
  const second = addRequest(db, { title: 'Подписка', body: 'продление', author: 'owner' })

  const merged = mergeRequests(db, { from: second.id, to: first.id, actor: 'owner' })

  assert.match(merged.body, /карты/)
  assert.match(merged.body, /продление/)
  assert.equal(getRequest(db, second.id)!.status, 'closed')

  const event = db
    .prepare("select after from events where type = 'request.merged' order by id desc limit 1")
    .get() as { after: string }
  assert.match(event.after, new RegExp(first.id))
})

test('нельзя объединить запрос с самим собой', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  assert.throws(() => mergeRequests(db, { from: request.id, to: request.id, actor: 'owner' }), /с собой/)
})

test('split создаёт части и закрывает исходный', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата и профиль', body: '', author: 'owner' })

  const parts = splitRequest(db, { id: request.id, into: ['Оплата', 'Профиль'], actor: 'owner' })

  assert.equal(parts.length, 2)
  assert.equal(getRequest(db, request.id)!.status, 'closed')
  assert.equal(parts[0].status, 'inbox')
})

test('split запроса в работе отвергается', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  addPlan(db, { requestId: request.id, title: 'Оплата', assumptions: [], stages: [] })
  approvePlan(db, { requestId: request.id, version: 1, actor: 'owner' })
  db.prepare('update plans set applied_at = ? where request_id = ?').run(new Date().toISOString(), request.id)

  assert.throws(() => splitRequest(db, { id: request.id, into: ['часть'], actor: 'owner' }), /в работе/)
})

test('remove удаляет запрос без фич и оставляет событие', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: 'текст', author: 'owner' })

  removeRequest(db, { id: request.id, actor: 'owner' })

  assert.equal(getRequest(db, request.id), null)
  const event = db
    .prepare("select type from events where subject = ? order by id desc limit 1")
    .get(request.id) as { type: string }
  assert.equal(event.type, 'request.removed')
})

test('remove отвергается, если у запроса есть фичи', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  addFeature(db, { requestId: request.id, name: 'Оплата', rank: 1 })

  assert.throws(() => removeRequest(db, { id: request.id, actor: 'owner' }), /фичи/)
})
