import test from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { getCard, listCards } from '../../src/core/cards.ts'
import { addDep } from '../../src/core/deps.ts'
import { listEvents } from '../../src/core/events.ts'
import {
  addToRun,
  dropFromRun,
  endRun,
  getActiveRun,
  getRun,
  listRunCards,
  listRuns,
  nextCard,
  reclaimExpired,
  releaseRun,
  suggestRuns,
  startRun,
} from '../../src/core/runs.ts'
import type { Card, CardStatus } from '../../src/core/types.ts'
import { makeBoard, seedCard, seedExecutor, seedRun } from '../helpers/board.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

/** Задача в очереди: позиция задаёт порядок, фаза task по умолчанию. */
function task(
  db: DatabaseSync,
  input: {
    position: number
    status?: CardStatus
    group?: string
    skill?: string
    title?: string
  },
): Card {
  return seedCard(db, {
    phase: 'task',
    status: input.status ?? 'ready',
    position: input.position,
    group: input.group ?? 'UI',
    skill: input.skill ?? 'dev',
    title: input.title ?? `Задача ${input.position}`,
  })
}

/** Четыре задачи UI-1..UI-4 с позициями 1..4. */
function fourTasks(db: DatabaseSync): Card[] {
  return [1, 2, 3, 4].map((position) => task(db, { position }))
}

const ids = (cards: Card[]): string[] => cards.map((card) => card.id)

test('suggestRuns собирает забег до run_size из карточек навыка исполнителя', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'], runSize: 3 })
  fourTasks(db)

  const suggestions = suggestRuns(db, 'developer', 2)
  assert.equal(suggestions.length, 2)
  assert.equal(suggestions[0].executorId, 'developer')
  assert.equal(suggestions[0].group, 'UI')
  assert.deepEqual(ids(suggestions[0].cards), ['UI-1', 'UI-2', 'UI-3'])
  assert.ok(suggestions[0].cards.every((card) => card.skill === 'dev'))

  // run_size — потолок: оставшаяся карточка образует забег из одной.
  assert.deepEqual(ids(suggestions[1].cards), ['UI-4'])

  const all = suggestions.flatMap((suggestion) => ids(suggestion.cards))
  assert.equal(new Set(all).size, all.length, 'предложения не пересекаются')
})

test('suggestRuns берёт задачи без position в порядке создания', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = seedCard(db, { phase: 'task', status: 'ready' })
  const second = seedCard(db, { phase: 'task', status: 'ready' })
  const third = seedCard(db, { phase: 'task', status: 'ready' })

  const [suggestion] = suggestRuns(db, 'developer', 1)
  assert.deepEqual(ids(suggestion.cards), [first.id, second.id, third.id])
})

test('suggestRuns учитывает навык, удержание, бронь, фазу и позицию', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })

  const dev = task(db, { position: 1 })
  task(db, { position: 2, skill: 'marketing', title: 'Маркетинг' })
  const held = task(db, { position: 3 })
  db.prepare("update cards set holder = 'marketer' where id = ?").run(held.id)
  const booked = task(db, { position: 4 })
  db.prepare("update cards set status = 'booked', run_id = 'RUN-9' where id = ?").run(booked.id)
  seedCard(db, { phase: 'request', status: 'new', position: 0, title: 'Запрос' })

  const suggestions = suggestRuns(db, 'developer', 3)
  assert.deepEqual(ids(suggestions[0].cards), [dev.id])
  assert.equal(suggestions.length, 1)

  assert.throws(() => suggestRuns(db, 'nobody', 1), /не найден/)
  assert.throws(() => suggestRuns(db, 'developer', 0), /целое число от 1/)
})

test('suggestRuns ставит waiting-карточку после её зависимости внутри забега', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  const first = task(db, { position: 1 })
  const second = task(db, { position: 2, status: 'waiting' })
  addDep(db, second.id, first.id)

  const [suggestion] = suggestRuns(db, 'developer', 1)
  assert.deepEqual(ids(suggestion.cards), [first.id, second.id])

  // waiting-карточка с зависимостью вне забега не предлагается.
  const external = task(db, { position: 3, status: 'in_progress' })
  const waiting = task(db, { position: 4, status: 'waiting' })
  addDep(db, waiting.id, external.id)

  const [next] = suggestRuns(db, 'developer', 1)
  assert.ok(!ids(next.cards).includes(waiting.id))
})

test('startRun бронирует карточки и запрещает второй активный забег', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'], runSize: 3 })
  fourTasks(db)

  const [suggestion] = suggestRuns(db, 'developer', 1)
  const run = startRun(db, {
    executorId: 'developer',
    cardIds: ids(suggestion.cards),
    actor: 'developer',
  })

  assert.equal(run.id, 'RUN-1')
  assert.equal(run.status, 'active')
  assert.equal(run.executorId, 'developer')
  assert.equal(run.review, false)
  assert.ok(run.leaseUntil !== null)
  assert.ok(run.leaseUntil > run.createdAt, 'lease на два часа вперёд')

  const held = listCards(db, { holder: 'developer' })
  assert.equal(held.length, 3)
  assert.ok(held.every((card) => card.status === 'booked' && card.runId === run.id))

  const runCards = listRunCards(db, run.id)
  assert.deepEqual(
    runCards.map((card) => card.status),
    ['booked', 'booked', 'booked'],
  )
  assert.deepEqual(
    runCards.map((card) => card.position),
    [1, 2, 3],
  )

  assert.deepEqual(getActiveRun(db, 'developer'), run)
  assert.ok(listEvents(db, run.id).some((event) => event.type === 'run.started'))
  assert.ok(listEvents(db, 'UI-1').some((event) => event.type === 'card.booked'))

  assert.throws(
    () => startRun(db, { executorId: 'developer', cardIds: ['UI-4'], actor: 'developer' }),
    /активный забег/,
  )
})

test('startRun принимает одну карточку и отвергает пустой и слишком большой забег', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'solo', skills: ['dev'], runSize: 2 })
  fourTasks(db)

  const run = startRun(db, { executorId: 'solo', cardIds: ['UI-1'], actor: 'solo' })
  assert.equal(run.status, 'active')
  assert.equal(listRunCards(db, run.id).length, 1)

  const { db: other } = board(t)
  seedExecutor(other, { id: 'solo', skills: ['dev'], runSize: 2 })
  fourTasks(other)

  assert.throws(
    () => startRun(other, { executorId: 'solo', cardIds: [], actor: 'solo' }),
    /хотя бы одна/,
  )
  assert.throws(
    () => startRun(other, { executorId: 'solo', cardIds: ['UI-1', 'UI-2', 'UI-3'], actor: 'solo' }),
    /не больше 2/,
  )
})

test('startRun проверяет навык, статус, доступность, дубликаты и существование', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  seedExecutor(db, { id: 'marketer', skills: ['marketing'] })

  const marketing = task(db, { position: 1, skill: 'marketing' })
  assert.throws(
    () => startRun(db, { executorId: 'developer', cardIds: [marketing.id], actor: 'developer' }),
    /навык/,
  )

  const request = seedCard(db, { phase: 'request', status: 'new', position: 2 })
  assert.throws(
    () => startRun(db, { executorId: 'developer', cardIds: [request.id], actor: 'developer' }),
    /запрос/,
  )

  const done = task(db, { position: 3, status: 'done' })
  assert.throws(
    () => startRun(db, { executorId: 'developer', cardIds: [done.id], actor: 'developer' }),
    /ready или waiting/,
  )

  const held = task(db, { position: 4 })
  db.prepare("update cards set holder = 'marketer' where id = ?").run(held.id)
  assert.throws(
    () => startRun(db, { executorId: 'developer', cardIds: [held.id], actor: 'developer' }),
    /забронирована/,
  )

  const free = task(db, { position: 5 })
  assert.throws(
    () => startRun(db, { executorId: 'developer', cardIds: [free.id, free.id], actor: 'developer' }),
    /дважды/,
  )
  assert.throws(
    () => startRun(db, { executorId: 'developer', cardIds: ['UI-99'], actor: 'developer' }),
    /не найдена/,
  )
  assert.throws(
    () => startRun(db, { executorId: 'nobody', cardIds: [free.id], actor: 'nobody' }),
    /не найден/,
  )
})

test('startRun атомарен: ошибка не бронирует ни одной карточки', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = task(db, { position: 1 })
  const second = task(db, { position: 2, status: 'done' })

  assert.throws(
    () => startRun(db, { executorId: 'developer', cardIds: [first.id, second.id], actor: 'developer' }),
    /ready или waiting/,
  )

  assert.equal(getCard(db, first.id)!.status, 'ready')
  assert.equal(getCard(db, first.id)!.holder, null)
  assert.equal(getCard(db, first.id)!.runId, null)
  assert.equal(listRuns(db).length, 0)
  assert.equal(db.prepare('select count(*) as n from run_cards').get()!.n, 0)
})

test('зависимость внутри забега разрешает waiting, внешняя и обратный порядок — нет', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  const first = task(db, { position: 1 })
  const second = task(db, { position: 2, status: 'waiting' })
  addDep(db, second.id, first.id)

  const run = startRun(db, {
    executorId: 'developer',
    cardIds: [first.id, second.id],
    actor: 'developer',
  })
  assert.deepEqual(listRunCards(db, run.id).map((card) => card.cardId), [first.id, second.id])

  const { db: other } = board(t)
  seedExecutor(other, { id: 'developer', skills: ['dev'] })
  const a = task(other, { position: 1 })
  const b = task(other, { position: 2, status: 'waiting' })
  addDep(other, b.id, a.id)

  assert.throws(
    () => startRun(other, { executorId: 'developer', cardIds: [b.id], actor: 'developer' }),
    /зависимость/,
  )
  assert.throws(
    () => startRun(other, { executorId: 'developer', cardIds: [b.id, a.id], actor: 'developer' }),
    /зависимость/,
  )
})

test('addToRun добавляет карточку, dropFromRun возвращает её в очередь', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'], runSize: 3 })
  fourTasks(db)

  const run = startRun(db, { executorId: 'developer', cardIds: ['UI-1'], actor: 'developer' })
  addToRun(db, { executorId: 'developer', cardId: 'UI-2', actor: 'developer' })

  assert.deepEqual(listRunCards(db, run.id).map((card) => card.cardId), ['UI-1', 'UI-2'])
  const added = getCard(db, 'UI-2')!
  assert.equal(added.status, 'booked')
  assert.equal(added.runId, run.id)
  assert.equal(added.holder, 'developer')
  assert.equal(added.leaseUntil, run.leaseUntil)

  assert.throws(
    () => addToRun(db, { executorId: 'developer', cardId: 'UI-2', actor: 'developer' }),
    /уже в забеге/,
  )
  assert.throws(
    () => addToRun(db, { executorId: 'developer', cardId: 'UI-99', actor: 'developer' }),
    /не найдена/,
  )

  dropFromRun(db, { executorId: 'developer', cardId: 'UI-2', actor: 'developer' })
  const dropped = getCard(db, 'UI-2')!
  assert.equal(dropped.status, 'ready')
  assert.equal(dropped.holder, null)
  assert.equal(dropped.runId, null)
  assert.equal(
    listRunCards(db, run.id).find((card) => card.cardId === 'UI-2')!.status,
    'dropped',
  )

  assert.throws(
    () => dropFromRun(db, { executorId: 'developer', cardId: 'UI-3', actor: 'developer' }),
    /не в забеге/,
  )

  // in_progress сначала закрывают или блокируют.
  db.prepare("update cards set status = 'in_progress' where id = 'UI-1'").run()
  db.prepare("update run_cards set status = 'in_progress' where card_id = 'UI-1'").run()
  assert.throws(
    () => dropFromRun(db, { executorId: 'developer', cardId: 'UI-1', actor: 'developer' }),
    /в работе/,
  )
})

test('addToRun не превышает run_size и проверяет зависимость', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'], runSize: 2 })
  const first = task(db, { position: 1 })
  const second = task(db, { position: 2 })
  const third = task(db, { position: 3 })
  const waiting = task(db, { position: 4, status: 'waiting' })
  addDep(db, waiting.id, third.id)

  startRun(db, { executorId: 'developer', cardIds: [first.id], actor: 'developer' })
  addToRun(db, { executorId: 'developer', cardId: second.id, actor: 'developer' })
  assert.throws(
    () => addToRun(db, { executorId: 'developer', cardId: third.id, actor: 'developer' }),
    /не больше 2/,
  )

  const { db: other } = board(t)
  seedExecutor(other, { id: 'developer', skills: ['dev'] })
  const dependency = task(other, { position: 1, status: 'in_progress' })
  const dependent = task(other, { position: 2, status: 'waiting' })
  const free = task(other, { position: 3 })
  addDep(other, dependent.id, dependency.id)
  startRun(other, { executorId: 'developer', cardIds: [free.id], actor: 'developer' })
  assert.throws(
    () => addToRun(other, { executorId: 'developer', cardId: dependent.id, actor: 'developer' }),
    /зависимость/,
  )
})

test('dropFromRun возвращает waiting, если зависимости не закрыты', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const dependency = task(db, { position: 1, status: 'in_progress' })
  const waiting = task(db, { position: 2, status: 'waiting' })
  addDep(db, waiting.id, dependency.id)

  seedRun(db, { executorId: 'developer', cardIds: [waiting.id] })
  dropFromRun(db, { executorId: 'developer', cardId: waiting.id, actor: 'developer' })
  assert.equal(getCard(db, waiting.id)!.status, 'waiting')
})

test('nextCard идёт по порядку, закрывает зависимости и пропускает blocked', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = task(db, { position: 1 })
  const second = task(db, { position: 2, status: 'waiting' })
  const third = task(db, { position: 3 })
  addDep(db, second.id, first.id)

  assert.equal(nextCard(db, { executorId: 'developer' }), null, 'без забега брать нечего')

  const run = startRun(db, {
    executorId: 'developer',
    cardIds: [first.id, second.id, third.id],
    actor: 'developer',
  })

  assert.equal(nextCard(db, { executorId: 'developer' })!.id, first.id)

  // Первая карточка закрыта внутри забега — вторая становится доступной.
  db.prepare("update run_cards set status = 'done' where run_id = ? and card_id = ?").run(
    run.id,
    first.id,
  )
  db.prepare("update cards set status = 'review' where id = ?").run(first.id)
  assert.equal(nextCard(db, { executorId: 'developer' })!.id, second.id)

  // Заблокированная карточка пропускается, даже если стоит первой.
  const { db: other } = board(t)
  seedExecutor(other, { id: 'developer', skills: ['dev'] })
  const a = task(other, { position: 1 })
  const b = task(other, { position: 2 })
  const otherRun = startRun(other, {
    executorId: 'developer',
    cardIds: [a.id, b.id],
    actor: 'developer',
  })
  other
    .prepare("update run_cards set status = 'blocked' where run_id = ? and card_id = ?")
    .run(otherRun.id, a.id)
  other.prepare("update cards set status = 'blocked', holder = null where id = ?").run(a.id)

  assert.equal(nextCard(other, { executorId: 'developer' })!.id, b.id)
})

test('endRun возвращает booked, снимает blocked и требует закрыть in_progress', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = task(db, { position: 1 })
  const second = task(db, { position: 2 })
  const third = task(db, { position: 3 })

  const run = startRun(db, {
    executorId: 'developer',
    cardIds: [first.id, second.id, third.id],
    actor: 'developer',
  })

  db.prepare("update cards set status = 'in_progress' where id = ?").run(first.id)
  db.prepare("update run_cards set status = 'in_progress' where card_id = ?").run(first.id)
  assert.throws(
    () => endRun(db, { executorId: 'developer', actor: 'developer' }),
    /в работе/,
  )

  db.prepare("update cards set status = 'booked' where id = ?").run(first.id)
  db.prepare("update run_cards set status = 'booked' where card_id = ?").run(first.id)
  db.prepare("update cards set status = 'blocked', holder = null where id = ?").run(third.id)
  db.prepare("update run_cards set status = 'blocked' where card_id = ?").run(third.id)

  const ended = endRun(db, { executorId: 'developer', actor: 'developer', review: true })
  assert.equal(ended.status, 'ended')
  assert.equal(ended.review, true)
  assert.ok(ended.endedAt !== null)
  assert.equal(getActiveRun(db, 'developer'), null)

  for (const id of [first.id, second.id]) {
    const card = getCard(db, id)!
    assert.equal(card.status, 'ready')
    assert.equal(card.holder, null)
    assert.equal(card.runId, null)
  }

  const blocked = getCard(db, third.id)!
  assert.equal(blocked.status, 'blocked')
  assert.equal(blocked.runId, null)

  assert.deepEqual(
    listRunCards(db, run.id).map((card) => card.status),
    ['dropped', 'dropped', 'dropped'],
  )
  assert.ok(listEvents(db, run.id).some((event) => event.type === 'run.ended'))

  assert.throws(
    () => endRun(db, { executorId: 'developer', actor: 'developer' }),
    /нет активного забега/,
  )
})

test('endRun возвращает зависящую карточку в waiting, если зависимость не закрыта', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const dependency = task(db, { position: 1, status: 'in_progress' })
  const dependent = task(db, { position: 2, status: 'waiting' })
  addDep(db, dependent.id, dependency.id)
  seedRun(db, { executorId: 'developer', cardIds: [dependent.id] })

  endRun(db, { executorId: 'developer', actor: 'developer' })
  assert.equal(getCard(db, dependent.id)!.status, 'waiting')
})

test('releaseRun снимает забег вручную с причиной', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = task(db, { position: 1 })
  const run = startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })
  db.prepare("update cards set status = 'in_progress' where id = ?").run(card.id)
  db.prepare("update run_cards set status = 'in_progress' where card_id = ?").run(card.id)

  const released = releaseRun(db, { runId: run.id, actor: 'owner', reason: 'агент умер' })
  assert.equal(released.status, 'cancelled')
  assert.equal(released.note, 'агент умер')
  assert.ok(released.endedAt !== null)

  const cardAfter = getCard(db, card.id)!
  assert.equal(cardAfter.status, 'ready')
  assert.equal(cardAfter.holder, null)
  assert.equal(cardAfter.runId, null)

  assert.throws(
    () => releaseRun(db, { runId: run.id, actor: 'owner', reason: 'ещё раз' }),
    /не активен/,
  )
  assert.throws(
    () => releaseRun(db, { runId: 'RUN-99', actor: 'owner', reason: 'нет такого' }),
    /не найден/,
  )

  const { db: other } = board(t)
  seedExecutor(other, { id: 'developer', skills: ['dev'] })
  const otherCard = task(other, { position: 1 })
  const otherRun = startRun(other, {
    executorId: 'developer',
    cardIds: [otherCard.id],
    actor: 'developer',
  })
  assert.throws(
    () => releaseRun(other, { runId: otherRun.id, actor: 'owner', reason: '  ' }),
    /причина/,
  )
})

test('reclaimExpired закрывает просроченный забег и возвращает карточки', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = task(db, { position: 1 })
  const second = task(db, { position: 2 })
  const run = startRun(db, {
    executorId: 'developer',
    cardIds: [first.id, second.id],
    actor: 'developer',
  })

  assert.equal(reclaimExpired(db), 0, 'свежий lease не трогаем')

  db.prepare("update runs set lease_until = '2000-01-01T00:00:00.000Z' where id = ?").run(run.id)
  assert.equal(reclaimExpired(db), 1)

  const expired = getRun(db, run.id)!
  assert.equal(expired.status, 'lease_expired')
  assert.ok(expired.endedAt !== null)
  assert.equal(getActiveRun(db, 'developer'), null)

  for (const id of [first.id, second.id]) {
    const card = getCard(db, id)!
    assert.equal(card.status, 'ready')
    assert.equal(card.holder, null)
    assert.equal(card.runId, null)
  }
  assert.equal(reclaimExpired(db), 0)

  // Явное «сейчас» тоже работает: забег с lease в будущем не просрочен.
  const future = startRun(db, { executorId: 'developer', cardIds: [first.id], actor: 'developer' })
  assert.equal(reclaimExpired(db, new Date()), 0)
  assert.equal(
    reclaimExpired(db, new Date(Date.now() + 3 * 60 * 60 * 1000)),
    1,
  )
  assert.equal(getRun(db, future.id)!.status, 'lease_expired')
})
