import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../../src/core/db.ts'
import { addRequest, closeKind, closeRequest, editRequest, openRequests, mergeRequests, getRequest, laterRequest, removeRequest, reopenRequest, splitRequest } from '../../src/core/requests.ts'
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

test('later требует дату и reopen возвращает в inbox', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })

  assert.throws(() => laterRequest(db, { id: request.id, until: ' ', actor: 'owner' }), /дата/)

  const later = laterRequest(db, { id: request.id, until: '2026-12-01', actor: 'owner' })
  assert.equal(later.status, 'later')
  assert.equal(later.reviewAt, '2026-12-01')

  const reopened = reopenRequest(db, { id: request.id, actor: 'owner' })
  assert.equal(reopened.status, 'inbox')
  assert.equal(reopened.reviewAt, null)
})

test('open возвращает только незакрытые запросы', () => {
  const db = openDb(':memory:')
  const first = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  const second = addRequest(db, { title: 'Профиль', body: '', author: 'owner' })
  closeRequest(db, { id: second.id, reason: 'решено', actor: 'owner' })

  const open = openRequests(db)
  assert.equal(open.length, 1)
  assert.equal(open[0].id, first.id)
})

test('open пуст, когда все запросы закрыты', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  closeRequest(db, { id: request.id, reason: 'решено', actor: 'owner' })

  assert.deepEqual(openRequests(db), [])
})

test('close закрывает запрос и пишет причину в журнал', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })

  const closed = closeRequest(db, { id: request.id, reason: 'реализовано в F4', actor: 'owner' })

  assert.equal(closed.status, 'closed')
  const event = db
    .prepare("select note from events where type = 'request.closed' order by id desc limit 1")
    .get() as { note: string }
  assert.equal(event.note, 'реализовано в F4')
})

test('close требует причину', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })

  assert.throws(() => closeRequest(db, { id: request.id, reason: '  ', actor: 'owner' }), /причина/)
})

test('close пишет вид закрытия, по умолчанию done', () => {
  const db = openDb(':memory:')
  const first = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  const second = addRequest(db, { title: 'Профиль', body: '', author: 'owner' })

  closeRequest(db, { id: first.id, reason: 'сделано', actor: 'owner' })
  closeRequest(db, { id: second.id, reason: 'передумали', kind: 'cancelled', actor: 'owner' })

  assert.equal(closeKind(db, first.id), 'done')
  assert.equal(closeKind(db, second.id), 'cancelled')
})

test('неизвестный вид закрытия отвергается', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })

  assert.throws(
    () => closeRequest(db, { id: request.id, reason: 'x', kind: 'later' as never, actor: 'owner' }),
    /done, cancelled/,
  )
})

test('объединённый запрос считается поглощённым', () => {
  const db = openDb(':memory:')
  const target = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  const source = addRequest(db, { title: 'Подписка', body: '', author: 'owner' })

  mergeRequests(db, { from: source.id, to: target.id, actor: 'owner' })

  assert.equal(closeKind(db, source.id), 'merged')
  assert.equal(closeKind(db, target.id), null)
})

test('запрос с незакрытыми фичами не закрывается и не закрывается дважды', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  addFeature(db, { requestId: request.id, name: 'Оплата', rank: 1 })

  assert.throws(() => closeRequest(db, { id: request.id, reason: 'готово', actor: 'owner' }), /фичи/)

  db.prepare("update features set status = 'done'").run()
  closeRequest(db, { id: request.id, reason: 'готово', actor: 'owner' })

  assert.throws(() => closeRequest(db, { id: request.id, reason: 'ещё раз', actor: 'owner' }), /уже закрыт/)
})

test('закрытый запрос не правится и не удаляется', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  closeRequest(db, { id: request.id, reason: 'решено', actor: 'owner' })

  assert.throws(() => editRequest(db, { id: request.id, title: 'Другое', actor: 'owner' }), /закрыт/)
  assert.throws(() => removeRequest(db, { id: request.id, actor: 'owner' }), /закрыт/)
})

test('старое закрытие без вида выводит вид из фич', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  addFeature(db, { requestId: request.id, name: 'Оплата', rank: 1 })
  db.prepare("update features set status = 'done'").run()
  db.prepare("update requests set status = 'closed' where id = ?").run(request.id)

  assert.equal(closeKind(db, request.id), 'done')
})

test('старое закрытие с отменённой фичей считается отменой', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  addFeature(db, { requestId: request.id, name: 'Оплата', rank: 1 })
  db.prepare("update features set status = 'cancelled'").run()
  db.prepare("update requests set status = 'closed' where id = ?").run(request.id)

  assert.equal(closeKind(db, request.id), 'cancelled')
})

test('закрытие без фич и без вида остаётся без вида', () => {
  const db = openDb(':memory:')
  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  db.prepare("update requests set status = 'closed' where id = ?").run(request.id)

  assert.equal(closeKind(db, request.id), null)
})



