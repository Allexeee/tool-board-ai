import test from 'node:test'
import assert from 'node:assert/strict'
import type { DatabaseSync } from 'node:sqlite'
import { editCard, getCard } from '../../src/core/cards.ts'
import {
  insertIntoQueue,
  listQueue,
  moveCard,
  reorderQueue,
  score,
} from '../../src/core/queue.ts'
import type { Card, CardPhase, CardStatus } from '../../src/core/types.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

/** Задача с оценкой: важность и срочность задают score = importance × urgency. */
function task(
  db: DatabaseSync,
  input: {
    importance?: number | null
    urgency?: number | null
    status?: CardStatus
    phase?: CardPhase
    position?: number | null
    group?: string
    skill?: string
    holder?: string
  } = {},
): Card {
  const card = seedCard(db, {
    phase: input.phase ?? 'task',
    status: input.status ?? 'ready',
    importance: input.importance ?? 0,
    urgency: input.urgency ?? 0,
    position: input.position,
    group: input.group,
    skill: input.skill,
  })
  if (input.holder !== undefined) {
    db.prepare('update cards set holder = ? where id = ?').run(input.holder, card.id)
    return getCard(db, card.id)!
  }
  return card
}

const ids = (cards: Card[]): string[] => cards.map((card) => card.id)
const positions = (cards: Card[]): Array<number | null> => cards.map((card) => card.position)

test('оценка — importance × urgency, пустые оценки считаются нулём', (t) => {
  const { db } = board(t)

  const high = task(db, { importance: 3, urgency: 3 })
  const low = task(db, { importance: 1, urgency: 1 })
  const zero = task(db, { importance: 0, urgency: 3 })
  const empty = seedCard(db)

  assert.equal(score(high), 9)
  assert.equal(score(low), 1)
  assert.equal(score(zero), 0)
  assert.equal(score(empty), 0)
})

test('вставка ставит карточки по оценке и нумерует позиции с 1', (t) => {
  const { db } = board(t)
  const low = task(db, { importance: 1, urgency: 1 }) // 1
  const high = task(db, { importance: 3, urgency: 3 }) // 9
  const mid = task(db, { importance: 2, urgency: 2 }) // 4

  insertIntoQueue(db, low.id)
  insertIntoQueue(db, high.id)
  insertIntoQueue(db, mid.id)

  const queue = listQueue(db)
  assert.deepEqual(ids(queue), [high.id, mid.id, low.id])
  assert.deepEqual(positions(queue), [1, 2, 3])
})

test('равные оценки встают после всех равных, то есть в конец группы', (t) => {
  const { db } = board(t)
  const first = task(db, { importance: 2, urgency: 2 })
  const second = task(db, { importance: 1, urgency: 4 })
  const third = task(db, { importance: 2, urgency: 2 })

  insertIntoQueue(db, first.id)
  insertIntoQueue(db, second.id)
  insertIntoQueue(db, third.id)

  assert.deepEqual(ids(listQueue(db)), [first.id, second.id, third.id])
})

test('карточка с наибольшей оценкой встаёт в начало, повторная вставка — no-op', (t) => {
  const { db } = board(t)
  const low = task(db, { importance: 1, urgency: 1 })
  const best = task(db, { importance: 3, urgency: 3 })

  insertIntoQueue(db, low.id)
  insertIntoQueue(db, best.id)

  assert.deepEqual(ids(listQueue(db)), [best.id, low.id])

  insertIntoQueue(db, best.id)
  assert.deepEqual(ids(listQueue(db)), [best.id, low.id])
  assert.deepEqual(positions(listQueue(db)), [1, 2])
})

test('в очередь ставятся задачи waiting/ready и запросы new/shaping', (t) => {
  const { db } = board(t)
  const request = task(db, { phase: 'request', status: 'new' })
  const approval = task(db, { phase: 'task', status: 'approval' })
  const done = task(db, { phase: 'task', status: 'done' })

  assert.throws(() => insertIntoQueue(db, 'UI-999'), /не найдена/)
  assert.equal(insertIntoQueue(db, request.id), undefined)
  assert.equal(listQueue(db, {}, 'request').length, 1)
  assert.throws(() => insertIntoQueue(db, approval.id), /new или shaping|waiting или ready/)
  assert.throws(() => insertIntoQueue(db, done.id), /new или shaping|waiting или ready/)
  assert.equal(listQueue(db).length, 0)
})

test('listQueue показывает все статусы очереди и не показывает approval, done и запросы', (t) => {
  const { db } = board(t)
  const visible: CardStatus[] = ['waiting', 'ready', 'booked', 'in_progress', 'blocked', 'review']
  const queue = visible.map((status, index) =>
    task(db, { status, position: index + 1, importance: 1, urgency: 1 }),
  )

  const hidden = [
    task(db, { phase: 'request', status: 'new', position: 7 }),
    task(db, { phase: 'task', status: 'approval', position: 8 }),
    task(db, { phase: 'task', status: 'done', position: 9 }),
    task(db, { phase: 'task', status: 'cancelled', position: 10 }),
  ]

  const listed = ids(listQueue(db))
  assert.deepEqual(listed, ids(queue))
  for (const card of hidden) assert.ok(!listed.includes(card.id), card.id)
  assert.equal(listQueue(db, { status: ['done'] }).length, 0)
})

test('moveCard переставляет наверх, вниз и перед карточкой, позиции перенумерованы', (t) => {
  const { db } = board(t)
  const a = task(db, { importance: 3, urgency: 3 })
  const b = task(db, { importance: 2, urgency: 3 })
  const c = task(db, { importance: 1, urgency: 3 })
  const d = task(db, { importance: 0, urgency: 3 })
  for (const card of [a, b, c, d]) insertIntoQueue(db, card.id)
  assert.deepEqual(ids(listQueue(db)), [a.id, b.id, c.id, d.id])

  moveCard(db, d.id, { top: true })
  assert.deepEqual(ids(listQueue(db)), [d.id, a.id, b.id, c.id])
  assert.deepEqual(positions(listQueue(db)), [1, 2, 3, 4])

  moveCard(db, d.id, { bottom: true })
  assert.deepEqual(ids(listQueue(db)), [a.id, b.id, c.id, d.id])

  moveCard(db, d.id, { before: b.id })
  assert.deepEqual(ids(listQueue(db)), [a.id, d.id, b.id, c.id])
  assert.deepEqual(positions(listQueue(db)), [1, 2, 3, 4])

  moveCard(db, c.id, { before: a.id })
  assert.deepEqual(ids(listQueue(db)), [c.id, a.id, d.id, b.id])
})

test('moveCard отказывает вне очереди, без цели и с чужой целью', (t) => {
  const { db } = board(t)
  const queued = task(db, { importance: 2, urgency: 2 })
  insertIntoQueue(db, queued.id)

  const approval = task(db, { status: 'approval' })
  assert.throws(() => moveCard(db, approval.id, { top: true }), /не в очереди/)
  assert.throws(() => moveCard(db, 'UI-999', { top: true }), /не найдена/)
  assert.throws(() => moveCard(db, queued.id, {}), /--before|--top|--bottom/)
  assert.throws(() => moveCard(db, queued.id, { top: true, bottom: true }), /одно/)
  assert.throws(() => moveCard(db, queued.id, { before: 'UI-999' }), /не найдена/)
  assert.throws(() => moveCard(db, queued.id, { before: approval.id }), /не в очереди/)
})

test('reorderQueue сортирует по оценке, внутри равных сохраняет текущий порядок', (t) => {
  const { db } = board(t)
  const x = task(db, { importance: 2, urgency: 2 }) // 4
  const y = task(db, { importance: 2, urgency: 2 }) // 4
  const z = task(db, { importance: 3, urgency: 3 }) // 9

  insertIntoQueue(db, x.id)
  insertIntoQueue(db, y.id)
  insertIntoQueue(db, z.id)
  assert.deepEqual(ids(listQueue(db)), [z.id, x.id, y.id])

  moveCard(db, y.id, { top: true })
  assert.deepEqual(ids(listQueue(db)), [y.id, z.id, x.id])

  reorderQueue(db)
  assert.deepEqual(ids(listQueue(db)), [z.id, y.id, x.id])
  assert.deepEqual(positions(listQueue(db)), [1, 2, 3])
})

test('listQueue фильтрует по статусу, группе, навыку, держателю и лимиту', (t) => {
  const { db } = board(t)
  const ui = task(db, { importance: 3, urgency: 3, holder: 'developer' })
  const uiWaiting = task(db, { status: 'waiting', importance: 2, urgency: 2, group: 'UI' })
  const im = task(db, {
    importance: 1,
    urgency: 3,
    group: 'IM',
    skill: 'marketing',
    holder: 'marketer',
  })

  insertIntoQueue(db, ui.id)
  insertIntoQueue(db, uiWaiting.id)
  insertIntoQueue(db, im.id)

  assert.deepEqual(ids(listQueue(db, { group: 'UI' })), [ui.id, uiWaiting.id])
  assert.deepEqual(ids(listQueue(db, { skill: 'marketing' })), [im.id])
  assert.deepEqual(ids(listQueue(db, { holder: 'developer' })), [ui.id])
  assert.deepEqual(ids(listQueue(db, { status: ['waiting'] })), [uiWaiting.id])
  assert.deepEqual(ids(listQueue(db, { limit: 2 })), [ui.id, uiWaiting.id])
  assert.deepEqual(ids(listQueue(db, { limit: 0 })), [])
  assert.deepEqual(ids(listQueue(db, { status: [] })), [])
})

test('очередь запросов: вставка по оценке, move и отдельность от задач', (t) => {
  const { db } = board(t)
  const low = task(db, { phase: 'request', status: 'new', importance: 1, urgency: 1 })
  const high = task(db, { phase: 'request', status: 'new', importance: 3, urgency: 3 })
  const mid = task(db, { phase: 'request', status: 'new', importance: 2, urgency: 2 })

  insertIntoQueue(db, low.id)
  insertIntoQueue(db, high.id)
  insertIntoQueue(db, mid.id)

  assert.deepEqual(ids(listQueue(db, {}, 'request')), [high.id, mid.id, low.id])

  moveCard(db, low.id, { top: true })
  assert.deepEqual(ids(listQueue(db, {}, 'request')), [low.id, high.id, mid.id])
  assert.equal(listQueue(db).length, 0)

  const deferred = task(db, { phase: 'request', status: 'new', importance: 3, urgency: 3 })
  insertIntoQueue(db, deferred.id)
  db.prepare("update cards set status = 'deferred', position = null where id = ?").run(deferred.id)
  assert.equal(listQueue(db, {}, 'request').some((card) => card.id === deferred.id), false)
})

test('демон растёт только при ручном понижении', (t) => {
  const { db } = board(t)
  const first = task(db, { position: 1 })
  const second = task(db, { position: 2 })
  const third = task(db, { position: 3 })

  moveCard(db, first.id, { bottom: true })
  assert.equal(getCard(db, first.id)!.demons, 1)

  moveCard(db, first.id, { top: true })
  assert.equal(getCard(db, first.id)!.demons, 1)

  moveCard(db, second.id, { bottom: true })
  assert.equal(getCard(db, second.id)!.demons, 1)
  assert.equal(getCard(db, third.id)!.demons, 0)
})

test('owner-очередь: move внутри класса, исполнители не сдвигаются', (t) => {
  const { db } = board(t)
  const first = task(db, { skill: 'owner', position: 1 })
  const second = task(db, { skill: 'owner', position: 2 })
  const dev = task(db, { position: 1 })

  moveCard(db, first.id, { bottom: true })
  assert.deepEqual(listQueue(db, { class: 'owner' }).map((card) => card.id), [second.id, first.id])
  assert.deepEqual(listQueue(db).map((card) => card.id), [dev.id])
  assert.equal(listQueue(db, { class: 'owner' })[0].position, 1)
  assert.equal(listQueue(db, { class: 'owner' })[1].position, 2)
})

test('owner-очередь: --before через классы даёт ошибку', (t) => {
  const { db } = board(t)
  const owner = task(db, { skill: 'owner', position: 1 })
  const dev = task(db, { position: 1 })

  assert.throws(() => moveCard(db, dev.id, { before: owner.id }), /разных очередях/)
})

test('owner-очередь: insert ставит в конец, reorder нумерует оба класса', (t) => {
  const { db } = board(t)
  const first = task(db, { skill: 'owner', position: 1 })
  const second = task(db, { skill: 'owner', position: null, importance: 3, urgency: 3 })
  const dev = task(db, { position: 1 })

  insertIntoQueue(db, second.id)
  assert.deepEqual(listQueue(db, { class: 'owner' }).map((card) => card.id), [first.id, second.id])

  reorderQueue(db)
  assert.deepEqual(listQueue(db, { class: 'owner' }).map((card) => card.position), [1, 2])
  assert.deepEqual(listQueue(db).map((card) => card.position), [1])
  assert.equal(getCard(db, dev.id)!.position, 1)
})

test('owner-карточка не ставится в очередь запросов', (t) => {
  const { db } = board(t)
  const owner = task(db, { phase: 'request', status: 'new', skill: 'owner' })

  insertIntoQueue(db, owner.id)
  assert.equal(getCard(db, owner.id)!.position, null)
  assert.equal(listQueue(db, {}, 'request').length, 0)
})

test('смена навыка на owner переносит карточку в owner-очередь', (t) => {
  const { db } = board(t)
  const card = task(db, { phase: 'request', status: 'new', importance: 2, urgency: 2 })
  insertIntoQueue(db, card.id)
  assert.ok(getCard(db, card.id)!.position)

  editCard(db, { id: card.id, actor: 'owner', patch: { skill: 'owner', needsMerge: false } })
  const edited = getCard(db, card.id)!
  assert.ok(edited.position)
  assert.equal(edited.phase, 'task')
  assert.equal(edited.status, 'ready')
  assert.equal(edited.reviewRequired, false)
  assert.equal(listQueue(db, {}, 'request').length, 0)
  assert.deepEqual(
    listQueue(db, { class: 'owner' }).map((item) => item.id),
    [card.id],
  )
})

test('queue reorder нумерует запросы без позиции и идемпотентен', (t) => {
  const { db } = board(t)
  const low = task(db, { phase: 'request', status: 'new', importance: 1, urgency: 1 })
  const high = task(db, { phase: 'request', status: 'new', importance: 3, urgency: 3 })
  const mid = task(db, { phase: 'request', status: 'new', importance: 2, urgency: 2 })
  assert.equal(getCard(db, high.id)!.position, null)

  reorderQueue(db)
  const queue = listQueue(db, {}, 'request')
  assert.deepEqual(queue.map((card) => card.id), [high.id, mid.id, low.id])
  assert.deepEqual(queue.map((card) => card.position), [1, 2, 3])

  reorderQueue(db)
  assert.deepEqual(listQueue(db, {}, 'request').map((card) => card.id), [high.id, mid.id, low.id])

  const approval = task(db, { phase: 'task', status: 'approval' })
  reorderQueue(db)
  assert.equal(getCard(db, approval.id)!.position, null)
})

test('queue reorder не нумерует owner-запросы', (t) => {
  const { db } = board(t)
  const owner = task(db, { phase: 'request', status: 'new', skill: 'owner', importance: 3, urgency: 3 })
  const normal = task(db, { phase: 'request', status: 'new', importance: 2, urgency: 2 })

  reorderQueue(db)

  assert.equal(getCard(db, owner.id)!.position, null)
  assert.equal(listQueue(db, {}, 'request').some((card) => card.id === owner.id), false)
  assert.equal(getCard(db, normal.id)!.position, 1)
})
