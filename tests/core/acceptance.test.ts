import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateAcceptance, recalculateAcceptance } from '../../src/core/acceptance.ts'
import { editCard, getCard } from '../../src/core/cards.ts'
import { acceptCard, finishCard, rejectAcceptance } from '../../src/core/lifecycle.ts'
import { submitVerdict } from '../../src/core/review.ts'
import { nowData } from '../../src/core/now.ts'
import { endRun, nextCard } from '../../src/core/runs.ts'
import { updateSettings } from '../../src/core/settings.ts'
import type { BoardSettings } from '../../src/core/settings.ts'
import { makeBoard, seedCard, seedRun } from '../helpers/board.ts'

function settings(overrides: Partial<BoardSettings> = {}): BoardSettings {
  return {
    version: 2,
    reviewer: { model: null },
    specReview: { mode: 'auto', maxSpecChars: 1500, largeSpecChars: 6000 },
    runReview: { mode: 'none' },
    review: {
      profile: 'custom',
      modelMap: { low: 'low', default: 'default', high: 'high', max: 'max' },
      profiles: {},
    },
    acceptance: { rules: [] },
    branches: { main: null, dev: null },
    git: true,
    sync: { remote: null },
    backlog: { path: 'docs/board/BACKLOG.md', auto: true, refreshSeconds: 5 },
    setupAt: null,
    ...overrides,
  }
}

test('правила: include по группе, тегу и пути, exclude сильнее', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const config = settings({
    acceptance: {
      rules: [
        {
          name: 'site',
          include: { groups: ['SITE'], tags: ['ui'], paths: ['src/components/**'] },
          exclude: { tags: ['no-acceptance'] },
        },
      ],
    },
  })
  const card = seedCard(board.db, { group: 'SITE', title: 't', tags: ['ui'], scope: ['src/**'] })
  assert.equal(evaluateAcceptance(config, card).required, true)

  const excluded = seedCard(board.db, {
    group: 'SITE',
    title: 'x',
    tags: ['ui', 'no-acceptance'],
    scope: ['src/**'],
  })
  assert.equal(evaluateAcceptance(config, excluded).required, false)

  const other = seedCard(board.db, { group: 'CORE', title: 'c', tags: ['fix'] })
  assert.equal(evaluateAcceptance(config, other).required, false)
})

test('правила: путь из фактического diff и общее исключение', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const config = settings({
    acceptance: {
      rules: [{ name: 'visual', include: { paths: ['src/ui/**'] } }],
      exclude: { tags: ['no-acceptance'] },
    },
  })
  const card = seedCard(board.db, { group: 'CORE', title: 'v' })
  assert.equal(evaluateAcceptance(config, card, ['src/ui/button.tsx']).required, true)
  assert.equal(evaluateAcceptance(config, card, ['src/core/db.ts']).required, false)

  const excluded = seedCard(board.db, { group: 'CORE', title: 'e', tags: ['no-acceptance'] })
  assert.equal(evaluateAcceptance(config, excluded, ['src/ui/button.tsx']).required, false)
})

test('recalculate не трогает ручной флаг', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const config = settings({
    acceptance: { rules: [{ name: 'site', include: { groups: ['SITE'] } }] },
  })
  const card = seedCard(board.db, { group: 'SITE', title: 's' })
  const auto = recalculateAcceptance(board.db, '', card, config)
  assert.equal(auto.ownerAcceptance, true)

  editCard(board.db, {
    id: card.id,
    actor: 'owner',
    patch: { ownerAcceptance: false, ownerAcceptanceManual: true },
  })
  const manual = recalculateAcceptance(board.db, '', getCard(board.db, card.id)!, config)
  assert.equal(manual.ownerAcceptance, false)
})

test('finish: флаг ведёт в acceptance, приёмка — в done', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'in_progress' })
  editCard(board.db, { id: card.id, actor: 'owner', patch: { needsMerge: false } })
  editCard(board.db, {
    id: card.id,
    actor: 'owner',
    patch: { ownerAcceptance: true, ownerAcceptanceManual: true },
  })
  board.db.prepare("update cards set holder = 'developer' where id = ?").run(card.id)

  const finished = finishCard(board.db, {
    id: card.id,
    actor: 'developer',
    summary: 'готово',
    root: '',
  })
  assert.equal(finished.status, 'acceptance')
  assert.equal(finished.doneAt, null)

  const accepted = acceptCard(board.db, { id: card.id, actor: 'owner' })
  assert.equal(accepted.status, 'done')
  assert.ok(accepted.doneAt !== null)
})

test('reject: возвращает прошлому держателю или в начало очереди', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'acceptance' })
  board.db
    .prepare("update cards set previous_holder = 'developer', holder = null where id = ?")
    .run(card.id)

  const rejected = rejectAcceptance(board.db, {
    id: card.id,
    actor: 'owner',
    reason: 'кнопка не та',
  })
  assert.equal(rejected.status, 'in_progress')
  assert.equal(rejected.holder, 'developer')
  assert.match(rejected.note ?? '', /кнопка/)

  const queued = seedCard(board.db, { phase: 'task', status: 'acceptance' })
  const back = rejectAcceptance(board.db, { id: queued.id, actor: 'owner', reason: 'ещё раз' })
  assert.equal(back.status, 'ready')
  assert.ok(back.position !== null)
})

test('run end закрывает забег с acceptance, run next его не выдаёт', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'ready' })
  const run = seedRun(board.db, { cardIds: [card.id] })
  board.db.prepare("update cards set status = 'acceptance' where id = ?").run(card.id)
  board.db
    .prepare("update run_cards set status = 'acceptance' where run_id = ? and card_id = ?")
    .run(run.id, card.id)

  const ended = endRun(board.db, { executorId: 'developer', actor: 'developer' })
  assert.equal(ended.status, 'ended')
  assert.equal(nextCard(board.db, { executorId: 'developer' }), null)
})

test('now и бэклог видят приёмку', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'acceptance', title: 'Принять' })
  const view = nowData(board.db, { view: 0, executorId: 'owner' })
  assert.equal(view.acceptanceCount, 1)
  assert.ok(view.ownerCards?.some((item) => item.id === card.id))
})

test('review submit done: флаг ведёт в acceptance', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'review' })
  editCard(board.db, {
    id: card.id,
    actor: 'owner',
    patch: { ownerAcceptance: true, ownerAcceptanceManual: true },
  })

  const result = submitVerdict(board.db, {
    cardId: card.id,
    reviewer: 'reviewer',
    verdict: 'done',
    note: 'ок',
    planCompliance: 'done',
    acceptance: 'done',
  })
  assert.equal(result.card.status, 'acceptance')
  assert.equal(result.card.doneAt, null)
})

test('accept/reject только из acceptance и только owner', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const card = seedCard(board.db, { phase: 'task', status: 'ready' })
  assert.throws(() => acceptCard(board.db, { id: card.id, actor: 'owner' }), /не ждёт/)
  assert.throws(
    () => acceptCard(board.db, { id: card.id, actor: 'developer' }),
    /владельца|приёмка/,
  )
  const acceptance = seedCard(board.db, { phase: 'task', status: 'acceptance' })
  assert.throws(
    () => rejectAcceptance(board.db, { id: acceptance.id, actor: 'owner', reason: '' }),
    /причин/,
  )
})
