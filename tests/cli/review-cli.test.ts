import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { makeBoard, seedCard } from '../helpers/board.ts'

const bin = resolve('bin/board.ts')

interface Result {
  code: number | null
  out: string
  err: string
}

function run(dir: string, args: string[]): Result {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  })
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' }
}

function fixture(t: { after: (fn: () => void) => void }) {
  const board = makeBoard()
  t.after(board.close)
  return board
}

test('review list отдаёт reopens, прошлые вердикты и открытые findings', (t) => {
  const { root, db } = fixture(t)
  const card = seedCard(db, { phase: 'task', status: 'review', position: 1 })
  db.prepare('update cards set review_reopens = 1 where id = ?').run(card.id)
  db.prepare(
    `insert into reviews (card_id, reviewer, verdict, note, at, kind, mode, spec_rev, plan_compliance)
     values (?, 'review', 'reopen', 'план не выполнен', '2026-01-01', 'run', 'subagent', 1, 'failed')`,
  ).run(card.id)
  const finding = run(root, [
    'review', 'finding', card.id,
    '--severity', 'important',
    '--text', 'добавить тест',
  ])
  assert.equal(finding.code, 0, finding.err)

  const items = JSON.parse(run(root, ['review', 'list', '--json']).out) as Array<{
    reviewReopens: number
    reviews: Array<{ verdict: string; planCompliance: string }>
    findings: Array<{ severity: string; title: string }>
  }>
  assert.equal(items[0].reviewReopens, 1)
  assert.equal(items[0].reviews[0].verdict, 'reopen')
  assert.equal(items[0].reviews[0].planCompliance, 'failed')
  assert.equal(items[0].findings[0].severity, 'important')
})

test('review submit требует --plan', (t) => {
  const { root, db } = fixture(t)
  const card = seedCard(db, { phase: 'task', status: 'review', position: 1 })

  const missing = run(root, ['review', 'submit', card.id, '--verdict', 'done', '--reviewer', 'r'])
  assert.equal(missing.code, 3)
  assert.match(missing.err, /--plan/)

  const failedDone = run(root, [
    'review', 'submit', card.id,
    '--plan', 'failed',
    '--verdict', 'done',
    '--reviewer', 'r',
  ])
  assert.equal(failedDone.code, 3)
  assert.match(failedDone.err, /reopen/)

  const done = run(root, [
    'review', 'submit', card.id,
    '--plan', 'done',
    '--verdict', 'done',
    '--reviewer', 'r',
  ])
  assert.equal(done.code, 0, done.err)
})

test('card verdict — алиас review submit с --plan', (t) => {
  const { root, db } = fixture(t)
  const card = seedCard(db, { phase: 'task', status: 'review', position: 1 })

  const missing = run(root, ['card', 'verdict', card.id, '--done', '--as', 'r'])
  assert.equal(missing.code, 3)
  assert.match(missing.err, /--plan/)

  const done = run(root, ['card', 'verdict', card.id, '--plan', 'done', '--done', '--as', 'r'])
  assert.equal(done.code, 0, done.err)
})

test('второй review reopen через CLI требует владельца', (t) => {
  const { root, db } = fixture(t)
  const card = seedCard(db, { phase: 'task', status: 'review', position: 1 })

  const first = run(root, [
    'review', 'submit', card.id,
    '--plan', 'failed',
    '--verdict', 'reopen',
    '--note', 'первый',
    '--reviewer', 'r',
  ])
  assert.equal(first.code, 0, first.err)
  db.prepare("update cards set status = 'review' where id = ?").run(card.id)

  const second = run(root, [
    'review', 'submit', card.id,
    '--plan', 'failed',
    '--verdict', 'reopen',
    '--note', 'второй',
    '--reviewer', 'r',
  ])
  assert.equal(second.code, 2)
  assert.match(second.err, /владельц/)

  const owner = run(root, [
    'review', 'submit', card.id,
    '--plan', 'failed',
    '--verdict', 'reopen',
    '--note', 'решение',
    '--reviewer', 'owner',
  ])
  assert.equal(owner.code, 0, owner.err)
})
