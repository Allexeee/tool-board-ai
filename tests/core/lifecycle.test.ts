import test from 'node:test'
import assert from 'node:assert/strict'
import { createCard, editCard, getCard } from '../../src/core/cards.ts'
import { addDep, listDeps } from '../../src/core/deps.ts'
import { ask, answer, openQuestions } from '../../src/core/discussion.ts'
import { listEvents } from '../../src/core/events.ts'
import { nowIso } from '../../src/core/clock.ts'
import {
  approveCard,
  blockCard,
  cancelCard,
  ownerDone,
  rejectCard,
  reopenCard,
  resumeAfterAnswer,
  shapeCard,
  submitCard,
} from '../../src/core/lifecycle.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

/** Обычный запрос: new → shaping → approval → ready по цепочке команд. */
function shapedRequest(t: { after: (fn: () => void) => void }, db: Board['db'], actor = 'developer') {
  const card = createCard(db, { group: 'UI', title: 'x', skill: 'dev', author: 'owner' })
  shapeCard(db, { id: card.id, actor })
  editCard(db, {
    id: card.id,
    actor,
    patch: { importance: 2, urgency: 3, scope: ['src/**'] },
  })
  return card
}

test('жизненный цикл: new → shaping → approval → ready, и block требует причину', (t) => {
  const { db } = board(t)

  const card = createCard(db, { group: 'UI', title: 'x', skill: 'dev', author: 'owner' })
  assert.throws(() => approveCard(db, { id: card.id, actor: 'owner' }), /approval/)

  shapeCard(db, { id: card.id, actor: 'developer' })
  editCard(db, {
    id: card.id,
    actor: 'developer',
    patch: { importance: 2, urgency: 3, scope: ['src/**'] },
  })
  submitCard(db, { id: card.id, actor: 'developer' })
  assert.equal(getCard(db, card.id)!.status, 'approval')

  approveCard(db, { id: card.id, actor: 'owner' })
  assert.equal(getCard(db, card.id)!.status, 'ready')

  assert.throws(
    () => blockCard(db, { id: card.id, actor: 'developer', reason: '', note: '' }),
    /причина/,
  )
})

test('shape переводит new в shaping: держатель, аренда и shaped_at', (t) => {
  const { db } = board(t)
  const card = seedCard(db)

  const shaped = shapeCard(db, { id: card.id, actor: 'developer' })

  assert.equal(shaped.status, 'shaping')
  assert.equal(shaped.phase, 'request')
  assert.equal(shaped.holder, 'developer')
  assert.ok(shaped.leaseUntil !== null && shaped.leaseUntil > nowIso())
  assert.ok(shaped.shapedAt !== null)

  const event = listEvents(db, card.id).at(-1)!
  assert.equal(event.type, 'card.shaped')
  assert.equal(event.actor, 'developer')
})

test('shape разбирает только new', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { status: 'shaping' })
  db.prepare('update cards set holder = ? where id = ?').run('developer', card.id)

  assert.throws(() => shapeCard(db, { id: card.id, actor: 'marketer' }), /shaping/)
  assert.equal(getCard(db, card.id)!.holder, 'developer')
})

test('submit принимает только держатель и требует оценки', (t) => {
  const { db } = board(t)
  const card = shapedRequest(t, db)

  assert.throws(() => submitCard(db, { id: card.id, actor: 'stranger' }), /держатель/)

  editCard(db, { id: card.id, actor: 'developer', patch: { importance: null } })
  assert.throws(() => submitCard(db, { id: card.id, actor: 'developer' }), /важность/)

  editCard(db, { id: card.id, actor: 'developer', patch: { importance: 2, scope: [] } })
  assert.throws(() => submitCard(db, { id: card.id, actor: 'developer' }), /scope/)
})

test('submit отправляет в approval и освобождает держателя', (t) => {
  const { db } = board(t)
  const card = shapedRequest(t, db)

  const submitted = submitCard(db, { id: card.id, actor: 'developer' })

  assert.equal(submitted.status, 'approval')
  assert.equal(submitted.phase, 'task')
  assert.equal(submitted.holder, null)
  assert.equal(submitted.leaseUntil, null)

  const event = listEvents(db, card.id).at(-1)!
  assert.equal(event.type, 'card.submitted')
  assert.equal(event.actor, 'developer')
})

test('owner-карточка с needs_merge=true не проходит submit', (t) => {
  const { db } = board(t)
  const card = createCard(db, { group: 'UI', title: 'x', skill: 'dev', author: 'owner' })
  shapeCard(db, { id: card.id, actor: 'developer' })
  // editCard уже не даст поставить skill=owner при needs_merge=true, поэтому
  // проверяем инвариант submitCard напрямую, минуя editCard.
  db.prepare(
    "update cards set skill = 'owner', importance = 2, urgency = 2 where id = ?",
  ).run(card.id)

  assert.throws(() => submitCard(db, { id: card.id, actor: 'developer' }), /owner|мерж/)
})

test('approve обычной карточки ставит её в очередь и делает ready', (t) => {
  const { db } = board(t)
  const card = shapedRequest(t, db)
  submitCard(db, { id: card.id, actor: 'developer' })

  const approved = approveCard(db, { id: card.id, actor: 'owner' })

  assert.equal(approved.status, 'ready')
  assert.ok(approved.position !== null)
  assert.ok(approved.approvedAt !== null)
  assert.equal(listEvents(db, card.id).at(-1)!.type, 'card.approved')
})

test('approve — только владелец и только из approval', (t) => {
  const { db } = board(t)
  const card = shapedRequest(t, db)
  submitCard(db, { id: card.id, actor: 'developer' })

  assert.throws(() => approveCard(db, { id: card.id, actor: 'developer' }), /владелец/)
  assert.throws(() => approveCard(db, { id: 'UI-999', actor: 'owner' }), /не найдена/)

  const fresh = seedCard(db)
  assert.throws(() => approveCard(db, { id: fresh.id, actor: 'owner' }), /approval/)
})

test('owner-карточка после approval становится ready без очереди', (t) => {
  const { db } = board(t)
  const card = createCard(db, { group: 'UI', title: 'x', skill: 'dev', author: 'owner' })
  shapeCard(db, { id: card.id, actor: 'developer' })
  editCard(db, {
    id: card.id,
    actor: 'developer',
    patch: { skill: 'owner', needsMerge: false, importance: 2, urgency: 2 },
  })
  submitCard(db, { id: card.id, actor: 'developer' })
  approveCard(db, { id: card.id, actor: 'owner' })

  const approved = getCard(db, card.id)!
  assert.equal(approved.status, 'ready')
  assert.equal(approved.needsMerge, false)
  assert.equal(approved.reviewRequired, false)
  assert.equal(approved.position, null)
})

test('reject возвращает в new, сохраняя содержимое, причина в журнале', (t) => {
  const { db } = board(t)
  const card = shapedRequest(t, db)
  submitCard(db, { id: card.id, actor: 'developer' })

  assert.throws(() => rejectCard(db, { id: card.id, actor: 'owner', reason: '' }), /причина/)

  const rejected = rejectCard(db, { id: card.id, actor: 'owner', reason: 'переделай' })
  assert.equal(rejected.status, 'new')
  assert.equal(rejected.phase, 'request')
  assert.equal(rejected.holder, null)
  assert.equal(rejected.importance, 2)
  assert.equal(rejected.urgency, 3)
  assert.deepEqual(rejected.scope, ['src/**'])

  const event = listEvents(db, card.id).at(-1)!
  assert.equal(event.type, 'card.rejected')
  assert.equal(event.actor, 'owner')
  assert.equal(event.note, 'переделай')
})

test('ownerDone закрывает owner-карточку без бронирования', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { skill: 'owner', group: 'OPS', title: 'Создать VK группу' })

  assert.throws(() => ownerDone(db, { id: card.id, actor: 'owner', summary: '' }), /отчёт/)

  const done = ownerDone(db, { id: card.id, actor: 'owner', summary: 'группа создана' })
  assert.equal(done.status, 'done')
  assert.equal(done.summary, 'группа создана')
  assert.ok(done.doneAt !== null)
  assert.equal(done.runId, null)

  const event = listEvents(db, card.id).at(-1)!
  assert.equal(event.type, 'card.done')
  assert.equal(event.actor, 'owner')
})

test('ownerDone отказывает не-owner карточкам и не в ready', (t) => {
  const { db } = board(t)
  const ownerCard = seedCard(db, { skill: 'owner' })
  const devCard = seedCard(db, { skill: 'dev', phase: 'task', status: 'ready' })

  assert.throws(() => ownerDone(db, { id: devCard.id, actor: 'owner', summary: 'x' }), /owner/)

  db.prepare("update cards set status = 'approval' where id = ?").run(ownerCard.id)
  assert.throws(() => ownerDone(db, { id: ownerCard.id, actor: 'owner', summary: 'x' }), /ready/)
})

test('owner-карточка не принимает review_required=true', (t) => {
  const { db } = board(t)
  const ownerCard = seedCard(db, { skill: 'owner' })

  assert.throws(
    () => editCard(db, { id: ownerCard.id, actor: 'owner', patch: { reviewRequired: true } }),
    /owner|ревью/,
  )
})

test('block в фазе request освобождает держателя и после ответа возвращает в new', (t) => {
  const { db } = board(t)
  const card = seedCard(db)
  shapeCard(db, { id: card.id, actor: 'developer' })

  const blocked = blockCard(db, { id: card.id, actor: 'developer', reason: 'нужно решение', note: 'какой SSO?' })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.phase, 'request')
  assert.equal(blocked.holder, null)

  const event = listEvents(db, card.id).at(-1)!
  assert.equal(event.type, 'card.blocked')
  assert.equal(event.note, 'нужно решение — какой SSO?')

  ask(db, { cardId: card.id, author: 'developer', text: 'какой SSO?' })
  answer(db, { cardId: card.id, actor: 'owner', questionId: openQuestions(db, card.id)[0].id, text: 'без SSO' })

  const resumed = resumeAfterAnswer(db, card.id, 'owner')!
  assert.equal(resumed.status, 'new')
})

test('block в фазе task и после ответа переходит в ready', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { phase: 'task', status: 'in_progress' })
  db.prepare('update cards set holder = ? where id = ?').run('developer', card.id)
  const question = ask(db, { cardId: card.id, author: 'developer', text: 'нужен доступ?' })

  const blocked = blockCard(db, { id: card.id, actor: 'developer', reason: 'нужен доступ', note: '' })
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.phase, 'task')
  assert.equal(blocked.holder, null)

  answer(db, { cardId: card.id, actor: 'owner', questionId: question.id, text: 'выдам' })
  const resumed = resumeAfterAnswer(db, card.id, 'owner')!
  assert.equal(resumed.status, 'ready')
})

test('resumeAfterAnswer не трогает карточку с открытыми вопросами и не blocked', (t) => {
  const { db } = board(t)
  const blocked = seedCard(db, { status: 'blocked', holder: null })
  const question = ask(db, { cardId: blocked.id, author: 'developer', text: 'первый' })
  ask(db, { cardId: blocked.id, author: 'developer', text: 'второй' })

  answer(db, { cardId: blocked.id, actor: 'owner', questionId: question.id, text: 'да' })
  assert.equal(resumeAfterAnswer(db, blocked.id, 'owner'), null)

  const ready = seedCard(db, { phase: 'task', status: 'ready' })
  assert.equal(resumeAfterAnswer(db, ready.id, 'owner'), null)
})

test('resumeAfterAnswer на task с незакрытой зависимостью ставит waiting', (t) => {
  const { db } = board(t)
  const dep = seedCard(db, { phase: 'task', status: 'booked' })
  const card = seedCard(db, { phase: 'task', status: 'blocked', holder: null })
  addDep(db, card.id, dep.id)
  const question = ask(db, { cardId: card.id, author: 'developer', text: 'что делать?' })

  answer(db, { cardId: card.id, actor: 'owner', questionId: question.id, text: 'жди' })
  const resumed = resumeAfterAnswer(db, card.id, 'owner')!
  assert.equal(resumed.status, 'waiting')
})

test('cancel отменяет карточку: держатель или владелец, waive_deps по флагу', (t) => {
  const { db } = board(t)
  const held = seedCard(db, { phase: 'task', status: 'in_progress' })
  db.prepare('update cards set holder = ? where id = ?').run('developer', held.id)
  const ready = seedCard(db, { phase: 'task', status: 'ready' })

  assert.throws(() => cancelCard(db, { id: held.id, actor: 'stranger', reason: 'x' }), /владелец|держатель/)
  assert.throws(() => cancelCard(db, { id: held.id, actor: 'developer', reason: '' }), /причина/)

  const cancelled = cancelCard(db, {
    id: held.id,
    actor: 'developer',
    reason: 'не нужно',
    waiveDeps: true,
  })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancelReason, 'не нужно')
  assert.equal(cancelled.waiveDeps, true)
  assert.equal(cancelled.holder, null)
  assert.equal(listEvents(db, held.id).at(-1)!.note, 'не нужно')

  // владелец отменяет любую
  const byOwner = cancelCard(db, { id: ready.id, actor: 'owner', reason: 'передумал' })
  assert.equal(byOwner.status, 'cancelled')
  assert.equal(byOwner.waiveDeps, false)
})

test('reopen увеличивает попытку, пишет previous_holder и двигает в начало очереди', (t) => {
  const { db } = board(t)
  const first = seedCard(db, { phase: 'task', status: 'ready', importance: 3, urgency: 3, position: 1 })
  const second = shapedRequest(t, db)
  submitCard(db, { id: second.id, actor: 'developer' })
  approveCard(db, { id: second.id, actor: 'owner' })
  db.prepare("update cards set status = 'review', holder = 'developer' where id = ?").run(second.id)

  assert.throws(() => reopenCard(db, { id: second.id, actor: 'owner', reason: '' }), /причина/)

  const reopened = reopenCard(db, { id: second.id, actor: 'owner', reason: 'переделать' })
  assert.equal(reopened.status, 'ready')
  assert.equal(reopened.attempt, 2)
  assert.equal(reopened.previousHolder, 'developer')
  assert.equal(reopened.holder, null)
  assert.equal(reopened.position, 1)

  assert.equal(listEvents(db, second.id).at(-1)!.note, 'переделать')
})

test('reopen с незакрытой зависимостью ставит waiting', (t) => {
  const { db } = board(t)
  const dep = seedCard(db, { phase: 'task', status: 'booked' })
  const card = seedCard(db, { phase: 'task', status: 'done', position: 1 })
  addDep(db, card.id, dep.id)

  const reopened = reopenCard(db, { id: card.id, actor: 'owner', reason: 'снова' })
  assert.equal(reopened.status, 'waiting')
  assert.equal(reopened.attempt, 2)
})
