import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { editCard, getCard } from '../../src/core/cards.ts'
import { openDb } from '../../src/core/db.ts'
import { addDep, listDeps } from '../../src/core/deps.ts'
import { finishCard, takeCard } from '../../src/core/lifecycle.ts'
import { initProject } from '../../src/core/project.ts'
import { release } from '../../src/core/release.ts'
import {
  addFinding,
  listReviewCards,
  revalidateDependents,
  submitVerdict,
} from '../../src/core/review.ts'
import { endRun, listRunCards, startRun, suggestRuns } from '../../src/core/runs.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'
import { commitGenerated, makeRepo } from '../helpers/repo.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

/** Доска внутри временного git-репозитория: release мержит dev в main. */
function repoBoard(t: { after: (fn: () => void) => void }): { root: string; db: DatabaseSync } {
  const repo = makeRepo()
  initProject(repo.root)
  commitGenerated(repo.root)
  const db = openDb(join(repo.root, '.board', 'board.db'))
  t.after(() => {
    db.close()
    repo.close()
  })
  return { root: repo.root, db }
}

test('reopen с критической находкой: карточка ждёт, находка блокирует release', (t) => {
  const { root, db } = repoBoard(t)
  const card = seedCard(db, { phase: 'task', status: 'review', needs_merge: true })

  const result = submitVerdict(db, {
    cardId: card.id,
    reviewer: 'reviewer-1',
    verdict: 'reopen',
    note: 'нет теста',
    findings: [{ severity: 'critical', text: 'нет теста на отказ' }],
  })

  // Критическая находка — зависимость карточки: она не готова, пока находка не done.
  assert.equal(result.card.status, 'waiting')
  assert.equal(result.card.previousHolder, card.holder)
  assert.equal(result.card.attempt, card.attempt)
  assert.equal(result.findings.length, 1)
  assert.equal(result.findings[0].severity, 'critical')
  assert.equal(result.findings[0].originCardId, card.id)
  assert.deepEqual(listDeps(db, card.id), [result.findings[0].id])

  assert.throws(() => release(db, root, 'owner'), /критич/)
})

test('done с important/other не блокирует release, critical — блокирует', (t) => {
  const { root, db } = repoBoard(t)
  const important = seedCard(db, { phase: 'task', status: 'review', needs_merge: true })
  const critical = seedCard(db, { phase: 'task', status: 'review', needs_merge: true })

  submitVerdict(db, {
    cardId: important.id,
    reviewer: 'reviewer-1',
    verdict: 'done',
    note: 'ok',
    findings: [
      { severity: 'important', text: 'добавить доку' },
      { severity: 'other', text: 'переименовать' },
    ],
  })

  const result = submitVerdict(db, {
    cardId: critical.id,
    reviewer: 'reviewer-1',
    verdict: 'done',
    note: 'ок',
    findings: [{ severity: 'critical', text: 'дыра в безопасности' }],
  })

  assert.equal(getCard(db, important.id)!.status, 'done')
  assert.equal(result.card.status, 'done')
  assert.equal(result.findings[0].severity, 'critical')

  // critical находка открыта — release блокируется
  assert.throws(() => release(db, root, 'owner'), /критич/)

  // закрываем находку — release проходит
  db.prepare("update cards set status = 'done' where id = ?").run(result.findings[0].id)
  assert.equal(release(db, root, 'owner').commit.length, 40)
})

test('addFinding наследует skill/needs_merge/scope и создаёт запрос', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { phase: 'task', status: 'review', needs_merge: true })
  db.prepare("update cards set scope = ?, skill = 'dev' where id = ?").run(
    JSON.stringify(['src/**', 'tests/**']),
    card.id,
  )

  const finding = addFinding(db, {
    cardId: card.id,
    reviewer: 'reviewer-1',
    severity: 'important',
    text: 'проверить границы',
  })

  assert.equal(finding.phase, 'request')
  assert.equal(finding.status, 'new')
  assert.equal(finding.group, card.group)
  assert.equal(finding.skill, 'dev')
  assert.equal(finding.needsMerge, true)
  assert.deepEqual(finding.scope, ['src/**', 'tests/**'])
  assert.equal(finding.originCardId, card.id)
  assert.equal(finding.body, 'проверить границы')
})

test('addFinding перекрывает skill и scope', (t) => {
  const { db } = board(t)
  const card = seedCard(db, { phase: 'task', status: 'review' })
  editCard(db, { id: card.id, actor: 'owner', patch: { needsMerge: false } })

  const finding = addFinding(db, {
    cardId: card.id,
    reviewer: 'reviewer-1',
    severity: 'other',
    text: 'стиль',
    skill: 'marketing',
    scope: ['docs/**'],
  })

  assert.equal(finding.skill, 'marketing')
  assert.deepEqual(finding.scope, ['docs/**'])
  assert.equal(finding.needsMerge, false)
})

test('listReviewCards возвращает карточки в review в порядке очереди', (t) => {
  const { db } = board(t)
  const second = seedCard(db, { phase: 'task', status: 'review', position: 2 })
  const first = seedCard(db, { phase: 'task', status: 'review', position: 1 })
  const notReview = seedCard(db, { phase: 'task', status: 'done', position: 3 })

  assert.deepEqual(
    listReviewCards(db).map((card) => card.id),
    [first.id, second.id],
  )
  assert.ok(!listReviewCards(db).some((card) => card.id === notReview.id))
})

test('reopen без критических находок: карточка ready, зависимые — waiting', (t) => {
  const { db } = board(t)
  const origin = seedCard(db, { phase: 'task', status: 'review', position: 1 })
  const dependent = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  addDep(db, dependent.id, origin.id)

  const result = submitVerdict(db, {
    cardId: origin.id,
    reviewer: 'reviewer-1',
    verdict: 'reopen',
    note: 'переделать',
  })

  assert.equal(result.card.status, 'ready')
  assert.equal(result.card.position, 1)
  assert.equal(getCard(db, dependent.id)!.status, 'waiting')
})

test('reopen снимает booked зависимого с забега в waiting', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const origin = seedCard(db, { phase: 'task', status: 'review', position: 1 })
  const dependent = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  editCard(db, { id: dependent.id, actor: 'owner', patch: { needsMerge: false } })
  addDep(db, dependent.id, origin.id)

  const run = startRun(db, { executorId: 'developer', cardIds: [dependent.id], actor: 'developer' })
  assert.equal(getCard(db, dependent.id)!.status, 'booked')

  submitVerdict(db, {
    cardId: origin.id,
    reviewer: 'reviewer-1',
    verdict: 'reopen',
    note: 'переделать',
  })

  assert.equal(getCard(db, dependent.id)!.status, 'waiting')
  const row = listRunCards(db, run.id).find((item) => item.cardId === dependent.id)!
  assert.equal(row.status, 'dropped')
})

test('finish in_progress зависимого отказывает, пока зависимость не review/done', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const origin = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  const dependent = seedCard(db, { phase: 'task', status: 'in_progress', position: 2 })
  editCard(db, { id: dependent.id, actor: 'owner', patch: { needsMerge: false } })
  db.prepare("update cards set holder = 'developer' where id = ?").run(dependent.id)
  addDep(db, dependent.id, origin.id)

  assert.throws(
    () => finishCard(db, { id: dependent.id, actor: 'developer', summary: 'x', root: '' }),
    /не закрыта/,
  )

  // зависимость закрылась — finish проходит
  db.prepare("update cards set status = 'review' where id = ?").run(origin.id)
  assert.equal(
    finishCard(db, { id: dependent.id, actor: 'developer', summary: 'x', root: '' }).status,
    'done',
  )
})

test('revalidateDependents: booked → waiting + dropped, ready → waiting, in_progress остаётся', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  // origin в review: зависимость закрыта, зависимых можно бронировать и брать.
  const origin = seedCard(db, { phase: 'task', status: 'review', position: 1 })

  const ready = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  addDep(db, ready.id, origin.id)

  const booked = seedCard(db, { phase: 'task', status: 'ready', position: 3 })
  editCard(db, { id: booked.id, actor: 'owner', patch: { needsMerge: false } })
  addDep(db, booked.id, origin.id)
  const run = startRun(db, { executorId: 'developer', cardIds: [booked.id], actor: 'developer' })

  const inProgress = seedCard(db, { phase: 'task', status: 'in_progress', position: 4 })
  editCard(db, { id: inProgress.id, actor: 'owner', patch: { needsMerge: false } })
  db.prepare("update cards set holder = 'developer' where id = ?").run(inProgress.id)
  addDep(db, inProgress.id, origin.id)

  // origin переоткрывается: зависимость перестаёт быть закрытой.
  db.prepare("update cards set status = 'ready' where id = ?").run(origin.id)

  const changed = revalidateDependents(db, origin.id)

  assert.equal(changed, 2)
  assert.equal(getCard(db, ready.id)!.status, 'waiting')
  assert.equal(getCard(db, booked.id)!.status, 'waiting')
  assert.equal(listRunCards(db, run.id).find((r) => r.cardId === booked.id)!.status, 'dropped')
  assert.equal(getCard(db, inProgress.id)!.status, 'in_progress')
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

  const result = submitVerdict(db, {
    cardId: card.id,
    reviewer: 'reviewer-1',
    verdict: 'reopen',
    note: 'переделать',
  })

  assert.equal(result.card.status, 'ready')
  assert.equal(result.card.runId, null)
  assert.equal(result.card.leaseUntil, null)
  assert.equal(result.card.holder, null)
  assert.equal(result.card.previousHolder, 'developer')

  // переоткрытая карточка снова предлагается и бронируется
  const suggested = suggestRuns(db, 'developer').flatMap((s) => s.cards.map((c) => c.id))
  assert.ok(suggested.includes(card.id))
  const second = startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })
  assert.equal(getCard(db, card.id)!.status, 'booked')
  assert.equal(getCard(db, card.id)!.runId, second.id)
})
