import test from 'node:test'
import assert from 'node:assert/strict'
import { createCard, editCard, getCard } from '../../src/core/cards.ts'
import { addDep, listDeps } from '../../src/core/deps.ts'
import { ask, answer, listDiscussion, openQuestions } from '../../src/core/discussion.ts'
import { listEvents } from '../../src/core/events.ts'
import { nowIso } from '../../src/core/clock.ts'
import {
  amendCard,
  applyShapeFile,
  approveCard,
  blockCard,
  cancelCard,
  deferCard,
  finishCard,
  ownerDone,
  rejectCard,
  reopenCard,
  resumeAfterAnswer,
  resumeCard,
  shapeCard,
  submitCard,
  takeCard,
} from '../../src/core/lifecycle.ts'
import { endRun, listRunCards, startRun, suggestRuns } from '../../src/core/runs.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'

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
    patch: {
      body: 'spec',
      acceptance: ['готово'],
      importance: 2,
      urgency: 3,
      scope: ['src/**'],
    },
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
    patch: {
      body: 'spec',
      acceptance: ['готово'],
      importance: 2,
      urgency: 3,
      scope: ['src/**'],
    },
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

test('shape разбирает только new или истёкший shaping', (t) => {
  const { db } = board(t)
  const card = seedCard(db, {
    status: 'shaping',
    holder: 'developer',
    leaseUntil: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  })

  assert.throws(() => shapeCard(db, { id: card.id, actor: 'marketer' }), /shaping/)
  assert.equal(getCard(db, card.id)!.holder, 'developer')

  // Если lease истёк, карточку можно перехватить
  db.prepare("update cards set lease_until = '2000-01-01T00:00:00.000Z' where id = ?").run(card.id)
  const reshaped = shapeCard(db, { id: card.id, actor: 'marketer' })
  assert.equal(reshaped.status, 'shaping')
  assert.equal(reshaped.holder, 'marketer')
  assert.ok(listEvents(db, card.id).some((e) => e.type === 'card.lease_expired'))
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

test('amend возвращает утверждённый spec в shaping и требует re-approve', (t) => {
  const { db } = board(t)
  const card = shapedRequest(t, db)
  submitCard(db, { id: card.id, actor: 'developer' })
  approveCard(db, { id: card.id, actor: 'owner' })
  const before = getCard(db, card.id)!

  const amended = amendCard(db, {
    id: card.id,
    actor: 'developer',
    reason: 'уточнили spec',
  })

  assert.equal(amended.status, 'shaping')
  assert.equal(amended.phase, 'request')
  assert.equal(amended.holder, 'developer')
  assert.equal(amended.approvedAt, null)
  assert.ok(amended.position)
  assert.equal(amended.specRev, before.specRev + 1)
  assert.throws(() => approveCard(db, { id: card.id, actor: 'owner' }), /approval/)

  // После amend spec снова редактируется и проходит обычный путь.
  editCard(db, {
    id: card.id,
    actor: 'developer',
    patch: { body: 'уточнённый spec', acceptance: ['готово'] },
  })
  submitCard(db, { id: card.id, actor: 'developer' })
  assert.equal(approveCard(db, { id: card.id, actor: 'owner' }).status, 'ready')
})

test('amend не обходит открытый вопрос', (t) => {
  const { db } = board(t)
  const card = seedCard(db)
  shapeCard(db, { id: card.id, actor: 'developer' })
  ask(db, { cardId: card.id, author: 'owner', text: 'Какой scope?' })
  blockCard(db, {
    id: card.id,
    actor: 'developer',
    reason: 'needs_decision',
    note: 'нужен ответ',
  })

  assert.throws(
    () => amendCard(db, { id: card.id, actor: 'developer', reason: 'обойти вопрос' }),
    /вопрос|ответ/,
  )
  assert.equal(getCard(db, card.id)!.status, 'blocked')
})

test('amend запрещён для карточки в работе', (t) => {
  const { db } = board(t)
  const card = shapedRequest(t, db)
  submitCard(db, { id: card.id, actor: 'developer' })
  approveCard(db, { id: card.id, actor: 'owner' })
  db.prepare("update cards set status = 'in_progress' where id = ?").run(card.id)

  assert.throws(
    () => amendCard(db, { id: card.id, actor: 'developer', reason: 'нельзя' }),
    /нельзя|status|in_progress/,
  )
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
    patch: {
      body: 'spec',
      acceptance: ['готово'],
      skill: 'owner',
      needsMerge: false,
      importance: 2,
      urgency: 2,
    },
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
  assert.equal(rejected.approvedAt, null)
  assert.equal(rejected.specRev, 3)

  const event = listEvents(db, card.id).at(-1)!
  assert.equal(event.type, 'card.rejected')
  assert.equal(event.actor, 'owner')
  assert.equal(event.note, 'переделай')

  // §10.1: причина отказа остаётся и в обсуждении.
  const comment = listDiscussion(db, card.id).find((item) => item.kind === 'comment')!
  assert.equal(comment.author, 'owner')
  assert.equal(comment.text, 'переделай')
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

test('reopen — только владелец, не-owner не обходит review', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { phase: 'task', status: 'review', position: 1 })

  assert.throws(
    () => reopenCard(db, { id: card.id, actor: 'developer', reason: 'обойти ревью' }),
    /владелец/,
  )
  assert.equal(getCard(db, card.id)!.status, 'review')
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

test('reopen owner-карточки не ставит её в очередь', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { skill: 'owner', group: 'OPS', title: 'VK' })
  ownerDone(db, { id: card.id, actor: 'owner', summary: 'готово' })

  const reopened = reopenCard(db, { id: card.id, actor: 'owner', reason: 'переделать' })
  assert.equal(reopened.status, 'ready')
  assert.equal(reopened.attempt, 2)
  assert.equal(reopened.position, null)
})

test('reopen очищает run_id/lease: карточка из finish снова бронируется', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  editCard(db, { id: card.id, actor: 'owner', patch: { needsMerge: false, reviewRequired: true } })
  const run = startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })
  takeCard(db, { id: card.id, actor: 'developer', root: '' })
  finishCard(db, { id: card.id, actor: 'developer', summary: 'готово', root: '' })

  // finish в review сохраняет забег и аренду — так устроены finish и endRun.
  assert.equal(getCard(db, card.id)!.status, 'review')
  assert.equal(getCard(db, card.id)!.runId, run.id)
  endRun(db, { executorId: 'developer', actor: 'developer' })

  const reopened = reopenCard(db, { id: card.id, actor: 'owner', reason: 'переделать' })

  assert.equal(reopened.status, 'ready')
  assert.equal(reopened.runId, null)
  assert.equal(reopened.leaseUntil, null)
  assert.equal(reopened.holder, null)
  assert.equal(reopened.previousHolder, 'developer')
  assert.equal(reopened.attempt, 2)

  // переоткрытая карточка снова предлагается и бронируется
  const suggested = suggestRuns(db, 'developer').flatMap((s) => s.cards.map((c) => c.id))
  assert.ok(suggested.includes(card.id))
  const second = startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })
  assert.equal(getCard(db, card.id)!.status, 'booked')
  assert.equal(getCard(db, card.id)!.runId, second.id)
})

test('block очищает run_id и аренду', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { phase: 'task', status: 'in_progress' })
  db.prepare("update cards set holder = ?, run_id = 'RUN-1', lease_until = ? where id = ?")
    .run('developer', nowIso(), card.id)

  const blocked = blockCard(db, { id: card.id, actor: 'developer', reason: 'стоп' })
  assert.equal(blocked.runId, null)
  assert.equal(blocked.leaseUntil, null)
  assert.equal(blocked.holder, null)
})

test('ownerDone разблокирует waiting зависимого', (t) => {
  const { db } = board(t)
  const ownerCard = seedCard(db, { skill: 'owner', group: 'OPS', title: 'VK' })
  const dependent = seedCard(db, { phase: 'task', status: 'waiting', position: 1 })
  addDep(db, dependent.id, ownerCard.id)
  assert.equal(getCard(db, dependent.id)!.status, 'waiting')

  ownerDone(db, { id: ownerCard.id, actor: 'owner', summary: 'создана' })
  assert.equal(getCard(db, dependent.id)!.status, 'ready')
})

test('reopenCard возвращает ready и booked зависимых в waiting', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const origin = seedCard(db, { phase: 'task', status: 'done', position: 1 })
  const readyDep = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  addDep(db, readyDep.id, origin.id)

  const bookedDep = seedCard(db, { phase: 'task', status: 'ready', position: 3 })
  editCard(db, { id: bookedDep.id, actor: 'owner', patch: { needsMerge: false } })
  addDep(db, bookedDep.id, origin.id)
  const run = startRun(db, { executorId: 'developer', cardIds: [bookedDep.id], actor: 'developer' })
  assert.equal(getCard(db, bookedDep.id)!.status, 'booked')

  reopenCard(db, { id: origin.id, actor: 'owner', reason: 'переделать' })

  assert.equal(getCard(db, readyDep.id)!.status, 'waiting')
  assert.equal(getCard(db, bookedDep.id)!.status, 'waiting')
  assert.equal(getCard(db, bookedDep.id)!.runId, null)
  assert.equal(getCard(db, bookedDep.id)!.holder, null)
  assert.equal(listRunCards(db, run.id).find((r) => r.cardId === bookedDep.id)!.status, 'dropped')
})

test('cancelCard с waiveDeps открывает waiting зависимого, без waive — возвращает ready/booked в waiting', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  // 1) waiveDeps: waiting -> ready
  const waivedOrigin = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  const waitingDep = seedCard(db, { phase: 'task', status: 'waiting', position: 2 })
  addDep(db, waitingDep.id, waivedOrigin.id)
  assert.equal(getCard(db, waitingDep.id)!.status, 'waiting')

  cancelCard(db, { id: waivedOrigin.id, actor: 'owner', reason: 'не нужно', waiveDeps: true })
  assert.equal(getCard(db, waitingDep.id)!.status, 'ready')

  // 2) без waiveDeps: ready/booked -> waiting
  const origin = seedCard(db, { phase: 'task', status: 'review', position: 3 })
  const readyDep = seedCard(db, { phase: 'task', status: 'ready', position: 4 })
  addDep(db, readyDep.id, origin.id)
  const bookedDep = seedCard(db, { phase: 'task', status: 'ready', position: 5 })
  editCard(db, { id: bookedDep.id, actor: 'owner', patch: { needsMerge: false } })
  addDep(db, bookedDep.id, origin.id)
  const run = startRun(db, { executorId: 'developer', cardIds: [bookedDep.id], actor: 'developer' })
  assert.equal(getCard(db, readyDep.id)!.status, 'ready')
  assert.equal(getCard(db, bookedDep.id)!.status, 'booked')

  cancelCard(db, { id: origin.id, actor: 'owner', reason: 'откат', waiveDeps: false })
  assert.equal(getCard(db, readyDep.id)!.status, 'waiting')
  assert.equal(getCard(db, bookedDep.id)!.status, 'waiting')
  assert.equal(listRunCards(db, run.id).find((r) => r.cardId === bookedDep.id)!.status, 'dropped')
})

test('take без забега: карточка в работе, finish закрывает, следующий take работает', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  const second = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  editCard(db, { id: first.id, actor: 'owner', patch: { needsMerge: false } })
  editCard(db, { id: second.id, actor: 'owner', patch: { needsMerge: false } })

  const taken = takeCard(db, { id: first.id, actor: 'developer', root: '' })
  assert.equal(taken.status, 'in_progress')
  assert.equal(taken.holder, 'developer')
  assert.equal(taken.runId, null)
  assert.ok(taken.leaseUntil)

  assert.throws(
    () => takeCard(db, { id: second.id, actor: 'developer', root: '' }),
    /уже есть карточка в работе/,
  )

  const finished = finishCard(db, { id: first.id, actor: 'developer', summary: 'готово', root: '' })
  assert.equal(finished.status, 'done')
  assert.equal(listRunCards(db, 'RUN-1').length, 0)

  const next = takeCard(db, { id: second.id, actor: 'developer', root: '' })
  assert.equal(next.status, 'in_progress')
  assert.equal(next.runId, null)
})

test('take без забега не берёт карточку с открытой зависимостью', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const origin = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  const dependent = seedCard(db, { phase: 'task', status: 'waiting', position: 2 })
  editCard(db, { id: dependent.id, actor: 'owner', patch: { needsMerge: false } })
  addDep(db, dependent.id, origin.id, 'owner', 'нужен сначала origin')

  assert.throws(
    () => takeCard(db, { id: dependent.id, actor: 'developer', root: '' }),
    /не закрыта/,
  )
})

test('cancelCard на карточке в in_progress помечает run_cards dropped и позволяет завершить забег', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  editCard(db, { id: card.id, actor: 'owner', patch: { needsMerge: false } })

  const run = startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })
  takeCard(db, { id: card.id, actor: 'developer', root: '' })
  assert.equal(getCard(db, card.id)!.status, 'in_progress')

  cancelCard(db, { id: card.id, actor: 'developer', reason: 'отмена в работе' })
  assert.equal(getCard(db, card.id)!.status, 'cancelled')
  assert.equal(listRunCards(db, run.id).find((r) => r.cardId === card.id)!.status, 'dropped')

  const ended = endRun(db, { executorId: 'developer', actor: 'developer' })
  assert.equal(ended.status, 'ended')
})

test('defer откладывает запрос и задачу, resume возвращает в очередь', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  const request = seedCard(db, { phase: 'request', status: 'new' })
  const task = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  db.prepare('update cards set approved_at = ? where id = ?').run(nowIso(), task.id)

  const deferredRequest = deferCard(db, { id: request.id, actor: 'developer' })
  assert.equal(deferredRequest.status, 'deferred')
  assert.equal(deferredRequest.holder, null)

  const deferredTask = deferCard(db, { id: task.id, actor: 'developer' })
  assert.equal(deferredTask.status, 'deferred')
  assert.equal(deferredTask.position, null)

  assert.equal(resumeCard(db, { id: request.id, actor: 'developer' }).status, 'new')
  const resumed = resumeCard(db, { id: task.id, actor: 'developer' })
  assert.equal(resumed.status, 'ready')
  assert.ok(resumed.position)

  assert.throws(
    () => resumeCard(db, { id: task.id, actor: 'developer' }),
    /не отложена/,
  )
})

test('defer снимает забронированную карточку с забега', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  editCard(db, { id: card.id, actor: 'owner', patch: { needsMerge: false } })
  const run = startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })

  const deferred = deferCard(db, { id: card.id, actor: 'developer' })
  assert.equal(deferred.status, 'deferred')
  assert.equal(deferred.runId, null)
  assert.equal(listRunCards(db, run.id).find((row) => row.cardId === card.id)!.status, 'dropped')

  // работающую карточку отложить нельзя
  const working = seedCard(db, { phase: 'task', status: 'in_progress', holder: 'developer' })
  assert.throws(
    () => deferCard(db, { id: working.id, actor: 'developer' }),
    /нельзя отложить/,
  )
})

test('defer/resume не обходят approve', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'approval' })

  deferCard(db, { id: card.id, actor: 'developer' })
  const resumed = resumeCard(db, { id: card.id, actor: 'developer' })
  assert.equal(resumed.status, 'approval')
  assert.equal(resumed.approvedAt, null)
  assert.throws(
    () => takeCard(db, { id: card.id, actor: 'developer', root: '' }),
    /не забронирована/,
  )
})

test('resume задачи с открытым вопросом возвращает blocked', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'blocked' })
  db.prepare('update cards set approved_at = ? where id = ?').run(nowIso(), card.id)
  ask(db, { cardId: card.id, author: 'developer', text: 'какой вариант?' })

  deferCard(db, { id: card.id, actor: 'developer' })
  const resumed = resumeCard(db, { id: card.id, actor: 'developer' })
  assert.equal(resumed.status, 'blocked')
  assert.throws(
    () => takeCard(db, { id: card.id, actor: 'developer', root: '' }),
    /не забронирована|ждёт ответа/,
  )
})

test('defer/resume проверяют держателя и навык', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'other', skills: ['dev'] })
  seedExecutor(db, { id: 'ui', skills: ['ui'] })

  const card = seedCard(db, { phase: 'task', status: 'ready', position: 1, holder: 'developer' })
  assert.throws(() => deferCard(db, { id: card.id, actor: 'other' }), /держит другой исполнитель/)
  assert.throws(() => deferCard(db, { id: card.id, actor: 'ui' }), /не подходит исполнителю/)

  const deferred = deferCard(db, { id: card.id, actor: 'owner' })
  assert.equal(deferred.status, 'deferred')
  assert.throws(() => resumeCard(db, { id: card.id, actor: 'ui' }), /не подходит исполнителю/)
  assert.equal(resumeCard(db, { id: card.id, actor: 'owner' }).status, 'approval')
})

test('одна карточка в работе на держателя держится при смешении забега и одиночного take', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const standalone = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  const inRun = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  editCard(db, { id: standalone.id, actor: 'owner', patch: { needsMerge: false } })
  editCard(db, { id: inRun.id, actor: 'owner', patch: { needsMerge: false } })

  takeCard(db, { id: standalone.id, actor: 'developer', root: '' })
  startRun(db, { executorId: 'developer', cardIds: [inRun.id], actor: 'developer' })

  assert.throws(
    () => takeCard(db, { id: inRun.id, actor: 'developer', root: '' }),
    /уже есть карточка в работе/,
  )
  assert.equal(getCard(db, inRun.id)!.status, 'booked')

  finishCard(db, { id: standalone.id, actor: 'developer', summary: 'готово', root: '' })
  const taken = takeCard(db, { id: inRun.id, actor: 'developer', root: '' })
  assert.equal(taken.status, 'in_progress')
})

test('после ответа на вопрос resume задачи возвращает её в очередь', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'blocked' })
  db.prepare('update cards set approved_at = ? where id = ?').run(nowIso(), card.id)
  const question = ask(db, { cardId: card.id, author: 'developer', text: 'какой вариант?' })

  deferCard(db, { id: card.id, actor: 'developer' })
  assert.equal(resumeCard(db, { id: card.id, actor: 'developer' }).status, 'blocked')

  answer(db, { cardId: card.id, questionId: question.id, text: 'второй', actor: 'owner' })
  deferCard(db, { id: card.id, actor: 'developer' })
  const resumed = resumeCard(db, { id: card.id, actor: 'developer' })
  assert.equal(resumed.status, 'ready')
  assert.ok(resumed.position)
})

test('продвижение запроса правилом забега фиксирует approved_at', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const request = seedCard(db, { phase: 'request', status: 'new' })
  startRun(db, { executorId: 'developer', cardIds: [request.id], actor: 'developer' })
  editCard(db, { id: request.id, actor: 'owner', patch: { needsMerge: false } })

  takeCard(db, { id: request.id, actor: 'developer', root: '' })
  editCard(db, {
    id: request.id,
    actor: 'developer',
    patch: { body: 'spec', acceptance: ['ok'], importance: 2, urgency: 2, scope: ['src/**'] },
  })

  const promoted = takeCard(db, { id: request.id, actor: 'developer', root: '' })
  assert.equal(promoted.status, 'in_progress')
  assert.ok(promoted.approvedAt)

  blockCard(db, { id: request.id, actor: 'developer', reason: 'needs_decision', note: '?' })
  deferCard(db, { id: request.id, actor: 'developer' })
  const resumed = resumeCard(db, { id: request.id, actor: 'developer' })
  assert.equal(resumed.status, 'ready')
})

test('approve сбрасывает позицию запроса и ставит задачу по оценке', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'approval', position: 5, importance: 3, urgency: 3 })

  const approved = approveCard(db, { id: card.id, actor: 'owner' })
  assert.equal(approved.status, 'ready')
  assert.equal(approved.position, 1)
})

test('запрос из shape-файла, resume и amend получают позицию', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  // new_cards из shape-файла
  const host = seedCard(db, { phase: 'request', status: 'new' })
  shapeCard(db, { id: host.id, actor: 'developer' })
  const shaped = applyShapeFile(db, {
    id: host.id,
    actor: 'developer',
    file: {
      new_cards: [{ key: 'a', group: 'UI', title: 'Новый', skill: 'dev' }],
    },
  })
  assert.equal(shaped.newCards.length, 1)
  assert.ok(shaped.newCards[0].position)

  // defer + resume запроса
  const request = seedCard(db, { phase: 'request', status: 'new' })
  deferCard(db, { id: request.id, actor: 'developer' })
  const resumed = resumeCard(db, { id: request.id, actor: 'developer' })
  assert.equal(resumed.status, 'new')
  assert.ok(resumed.position)

  // amend запроса
  const approved = seedCard(db, { phase: 'task', status: 'approval' })
  const amended = amendCard(db, { id: approved.id, actor: 'developer', reason: 'уточнение' })
  assert.equal(amended.status, 'shaping')
  assert.ok(amended.position)
})
