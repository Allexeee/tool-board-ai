import test from 'node:test'
import assert from 'node:assert/strict'
import { getCard } from '../../src/core/cards.ts'
import { listEvents } from '../../src/core/events.ts'
import { takeCard } from '../../src/core/lifecycle.ts'
import { doctorData } from '../../src/core/doctor.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'

type Board = ReturnType<typeof makeBoard>

function setup(t: { after: (fn: () => void) => void }, reviewRequired: boolean): Board {
  const board = makeBoard()
  t.after(board.close)
  seedExecutor(board.db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(board.db, { phase: 'task', status: 'ready', skill: 'dev' })
  board.db.prepare('update cards set needs_merge = 0, review_required = ? where id = ?').run(
    reviewRequired ? 1 : 0,
    card.id,
  )
  return board
}

test('take: карточка с ревью без шагов отказывает', (t) => {
  const board = setup(t, true)
  const card = getCard(board.db, 'UI-1')!

  assert.throws(
    () => takeCard(board.db, { id: card.id, actor: 'developer', root: '' }),
    /нет шагов плана/,
  )
})

test('take --no-plan: проходит и оставляет отметку', (t) => {
  const board = setup(t, true)
  const card = getCard(board.db, 'UI-1')!

  const taken = takeCard(board.db, { id: card.id, actor: 'developer', root: '', noPlan: true })
  assert.equal(taken.status, 'in_progress')
  assert.equal(taken.planWaived, true)
  assert.ok(listEvents(board.db, card.id).some((event) => event.type === 'card.plan_waived'))
})

test('take: без ревью план не требуется', (t) => {
  const board = setup(t, false)
  const card = getCard(board.db, 'UI-1')!

  const taken = takeCard(board.db, { id: card.id, actor: 'developer', root: '' })
  assert.equal(taken.status, 'in_progress')
  assert.equal(taken.planWaived, false)
})

test('doctor: предупреждает о done без плана и без отметки', (t) => {
  const board = setup(t, true)
  const card = getCard(board.db, 'UI-1')!
  board.db.prepare("update cards set status = 'done' where id = ?").run(card.id)

  const data = doctorData(board.db, board.root)
  assert.ok(
    data.warnings.some((warning) => warning.includes('без плана') && warning.includes(card.id)),
    data.warnings.join(' | '),
  )
})
