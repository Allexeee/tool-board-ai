import test from 'node:test'
import assert from 'node:assert/strict'
import { getCard } from '../../src/core/cards.ts'
import { listEvents } from '../../src/core/events.ts'
import {
  addDep,
  isSatisfied,
  listDeps,
  refreshReadiness,
  removeDep,
  wouldCycle,
} from '../../src/core/deps.ts'
import type { CardPhase, CardStatus } from '../../src/core/types.ts'
import { makeBoard, seedCard } from '../helpers/board.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

test('закрытая зависимость переводит задачу из waiting в ready', (t) => {
  const { db } = board(t)
  const done = seedCard(db, { phase: 'task', status: 'in_progress' })
  const waiting = seedCard(db, { phase: 'task', status: 'waiting' })

  addDep(db, waiting.id, done.id)
  db.prepare("update cards set status = 'done' where id = ?").run(done.id)

  assert.equal(refreshReadiness(db), 1)
  assert.equal(getCard(db, waiting.id)!.status, 'ready')

  const event = listEvents(db, waiting.id).at(-1)!
  assert.equal(event.type, 'card.readiness')
  assert.equal(event.actor, 'system')
  assert.equal(JSON.parse(event.before!).status, 'waiting')
  assert.equal(JSON.parse(event.after!).status, 'ready')
})

test('ревью удовлетворяет зависимость', (t) => {
  const { db } = board(t)
  const review = seedCard(db, { phase: 'task', status: 'review' })
  const waiting = seedCard(db, { phase: 'task', status: 'waiting' })

  addDep(db, waiting.id, review.id)
  refreshReadiness(db)

  assert.equal(getCard(db, waiting.id)!.status, 'ready')
})

test('cancelled без waive_deps не удовлетворяет зависимость, с waive_deps — удовлетворяет', (t) => {
  const { db } = board(t)
  const cancelled = seedCard(db, { phase: 'task', status: 'cancelled' })
  const waiting = seedCard(db, { phase: 'task', status: 'waiting' })
  addDep(db, waiting.id, cancelled.id)

  assert.equal(refreshReadiness(db), 0)
  assert.equal(getCard(db, waiting.id)!.status, 'waiting')

  const waived = seedCard(db, { phase: 'task', status: 'cancelled', waiveDeps: false })
  const second = seedCard(db, { phase: 'task', status: 'waiting' })
  addDep(db, second.id, waived.id)
  db.prepare('update cards set waive_deps = 1 where id = ?').run(waived.id)

  assert.equal(refreshReadiness(db), 1)
  assert.equal(getCard(db, second.id)!.status, 'ready')
})

test('isSatisfied: только review, done и waived cancelled', (t) => {
  const { db } = board(t)
  const expected: Array<[CardStatus, boolean]> = [
    ['new', false],
    ['shaping', false],
    ['approval', false],
    ['waiting', false],
    ['ready', false],
    ['booked', false],
    ['in_progress', false],
    ['blocked', false],
    ['review', true],
    ['done', true],
    ['cancelled', false],
  ]

  for (const [status, satisfied] of expected) {
    const card = seedCard(db, { phase: 'task', status })
    assert.equal(isSatisfied(db, card.id), satisfied, status)
  }

  const waived = seedCard(db, { phase: 'task', status: 'cancelled', waiveDeps: true })
  assert.equal(isSatisfied(db, waived.id), true)
  assert.throws(() => isSatisfied(db, 'UI-999'), /не найдена/)
})

test('refreshReadiness не трогает чужие фазы и статусы', (t) => {
  const { db } = board(t)
  const blocker = seedCard(db, { phase: 'task', status: 'in_progress' })
  const cases: Array<[CardPhase, CardStatus]> = [
    ['request', 'new'],
    ['task', 'approval'],
    ['task', 'booked'],
    ['task', 'in_progress'],
    ['task', 'review'],
    ['task', 'done'],
    ['task', 'cancelled'],
  ]

  const cards = cases.map(([phase, status]) => seedCard(db, { phase, status }))
  for (const card of cards) addDep(db, card.id, blocker.id)

  assert.equal(refreshReadiness(db), 0)
  cards.forEach((card, index) => {
    assert.equal(getCard(db, card.id)!.status, cases[index][1])
  })
  assert.equal(getCard(db, blocker.id)!.status, 'in_progress')
})

test('ready с незакрытой зависимостью возвращается в waiting', (t) => {
  const { db } = board(t)
  const blocker = seedCard(db, { phase: 'task', status: 'booked' })
  const ready = seedCard(db, { phase: 'task', status: 'ready' })
  addDep(db, ready.id, blocker.id)

  assert.equal(getCard(db, ready.id)!.status, 'waiting')
  assert.equal(getCard(db, blocker.id)!.status, 'booked')
})

test('waiting с несколькими зависимостями ждёт последнюю', (t) => {
  const { db } = board(t)
  const done = seedCard(db, { phase: 'task', status: 'done' })
  const cancelled = seedCard(db, { phase: 'task', status: 'cancelled' })
  const waiting = seedCard(db, { phase: 'task', status: 'waiting' })

  addDep(db, waiting.id, done.id)
  addDep(db, waiting.id, cancelled.id)

  assert.equal(refreshReadiness(db), 0)
  assert.equal(getCard(db, waiting.id)!.status, 'waiting')
})

test('refreshReadiness пишет событие только при смене статуса', (t) => {
  const { db } = board(t)
  const done = seedCard(db, { phase: 'task', status: 'in_progress' })
  const waiting = seedCard(db, { phase: 'task', status: 'waiting' })
  addDep(db, waiting.id, done.id)
  db.prepare("update cards set status = 'done' where id = ?").run(done.id)

  assert.equal(refreshReadiness(db), 1)
  const countAfterChange = listEvents(db, waiting.id).length

  assert.equal(refreshReadiness(db), 0)
  assert.equal(listEvents(db, waiting.id).length, countAfterChange)
})

test('добавление и удаление зависимости', (t) => {
  const { db } = board(t)
  const first = seedCard(db, { phase: 'task', status: 'done' })
  const second = seedCard(db, { phase: 'task', status: 'done' })
  const waiting = seedCard(db, { phase: 'task', status: 'waiting' })

  addDep(db, waiting.id, second.id)
  addDep(db, waiting.id, first.id)
  assert.deepEqual(listDeps(db, waiting.id), [first.id, second.id])

  addDep(db, waiting.id, first.id)
  assert.deepEqual(listDeps(db, waiting.id), [first.id, second.id])

  removeDep(db, waiting.id, first.id)
  assert.deepEqual(listDeps(db, waiting.id), [second.id])
  assert.throws(() => removeDep(db, waiting.id, first.id), /не найдена/)
})

test('причина добавления и удаления зависимости пишется в журнал', (t) => {
  const { db } = board(t)
  const blocker = seedCard(db, { phase: 'task', status: 'done' })
  const waiting = seedCard(db, { phase: 'task', status: 'ready' })

  addDep(db, waiting.id, blocker.id, 'developer', 'форма ждёт API')
  const added = listEvents(db, waiting.id).at(-1)!
  assert.equal(added.type, 'dep.added')
  assert.equal(added.actor, 'developer')
  assert.equal(added.note, 'форма ждёт API')

  const second = seedCard(db, { phase: 'task', status: 'done' })
  addDep(db, waiting.id, second.id)
  assert.equal(listEvents(db, waiting.id).at(-1)!.note, null)

  removeDep(db, waiting.id, blocker.id, 'owner', 'зависимость снята')
  const removed = listEvents(db, waiting.id).at(-1)!
  assert.equal(removed.type, 'dep.removed')
  assert.equal(removed.actor, 'owner')
  assert.equal(removed.note, 'зависимость снята')
})

test('удаление последней зависимости делает задачу готовой, а добавление незакрытой — waiting', (t) => {
  const { db } = board(t)
  const blocker = seedCard(db, { phase: 'task', status: 'booked' })
  const card = seedCard(db, { phase: 'task', status: 'ready' })

  addDep(db, card.id, blocker.id)
  assert.equal(getCard(db, card.id)!.status, 'waiting')

  removeDep(db, card.id, blocker.id)
  assert.equal(getCard(db, card.id)!.status, 'ready')
})

test('цикл отвергается с путём, самозависимость тоже', (t) => {
  const { db } = board(t)
  const a = seedCard(db)
  const b = seedCard(db)
  const c = seedCard(db)

  addDep(db, b.id, a.id)
  addDep(db, c.id, b.id)

  assert.deepEqual(wouldCycle(db, b.id, c.id), [c.id, b.id, c.id])
  assert.throws(
    () => addDep(db, b.id, c.id),
    new RegExp(`цикл зависимостей: ${c.id} → ${b.id} → ${c.id}`),
  )
  assert.throws(() => addDep(db, a.id, a.id), /цикл/)

  const x = seedCard(db)
  const y = seedCard(db)
  assert.equal(wouldCycle(db, x.id, y.id), null)
})

test('addDep проверяет существование карточек', (t) => {
  const { db } = board(t)
  const card = seedCard(db)

  assert.throws(() => addDep(db, card.id, 'UI-999'), /карточка UI-999 не найдена/)
  assert.throws(() => addDep(db, 'UI-999', card.id), /карточка UI-999 не найдена/)
  assert.deepEqual(listDeps(db, card.id), [])
})
