import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { editCard, getCard } from '../../src/core/cards.ts'
import { addDep } from '../../src/core/deps.ts'
import { openDb } from '../../src/core/db.ts'
import { isAncestor, runGit } from '../../src/core/git.ts'
import { blockCard, finishCard, takeCard, touchCard } from '../../src/core/lifecycle.ts'
import { initProject } from '../../src/core/project.ts'
import { endRun, getActiveRun, listRunCards, nextCard, startRun } from '../../src/core/runs.ts'
import { makeBoard, seedCard, seedExecutor } from '../helpers/board.ts'
import { commitGenerated, makeRepo } from '../helpers/repo.ts'

type Board = ReturnType<typeof makeBoard>

function board(t: { after: (fn: () => void) => void }): Board {
  const fixture = makeBoard()
  t.after(fixture.close)
  return fixture
}

/** Доска внутри временного git-репозитория: take/finish трогают worktree и dev. */
function repoBoard(t: { after: (fn: () => void) => void }): { root: string; db: DatabaseSync } {
  const repo = makeRepo()
  initProject(repo.root)
  commitGenerated(repo.root)
  const db = openDb(join(repo.root, '.board', 'board.db'))
  t.after(() => {
    db.close()
    repo.close()
  })
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  return { root: repo.root, db }
}

/** Карточка в забеге developer с worktree: booked → take → in_progress. */
function taken(
  root: string,
  db: DatabaseSync,
  scope: string[] = ['src/**'],
): { cardId: string; branch: string; worktree: string } {
  const card = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  editCard(db, { id: card.id, actor: 'owner', patch: { scope } })
  startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })
  takeCard(db, { id: card.id, actor: 'developer', root })
  return {
    cardId: card.id,
    branch: `card/${card.id}`,
    worktree: join(root, '.worktrees', 'developer'),
  }
}

function commit(wt: string, files: Record<string, string>, message: string): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(wt, path, '..'), { recursive: true })
    writeFileSync(join(wt, path), text)
  }
  runGit(wt, ['add', '.'])
  runGit(wt, ['commit', '-m', message])
}

test('take создаёт ветку и worktree, finish мержит в dev и ставит done', (t) => {
  const { root, db } = repoBoard(t)
  const { cardId, branch } = taken(root, db)

  const card = getCard(db, cardId)!
  assert.equal(card.status, 'in_progress')
  assert.equal(card.branch, branch)
  assert.equal(existsSync(join(root, '.worktrees', 'developer')), true)

  commit(join(root, '.worktrees', 'developer'), { 'src/app.ts': 'export const x = 1\n' }, 'add app')

  const finished = finishCard(db, { id: cardId, actor: 'developer', summary: 'готово', root })
  assert.equal(finished.status, 'done')
  assert.equal(finished.summary, 'готово')
  assert.ok(finished.doneAt !== null)
  assert.ok(finished.mergeCommit !== null)
  assert.equal(finished.inDev, true)
  assert.equal(finished.inMain, false)
  assert.equal(isAncestor(root, finished.mergeCommit!, 'dev'), true)

  const run = getActiveRun(db, 'developer')
  const row = listRunCards(db, run!.id).find((item) => item.cardId === cardId)!
  assert.equal(row.status, 'done')
})

test('грязный worktree отказывает finish и оставляет карточку в работе', (t) => {
  const { root, db } = repoBoard(t)
  const { cardId, branch, worktree } = taken(root, db)

  writeFileSync(join(worktree, 'dirty.txt'), 'x')

  assert.throws(
    () => finishCard(db, { id: cardId, actor: 'developer', summary: 'x', root }),
    /грязн/,
  )
  const card = getCard(db, cardId)!
  assert.equal(card.status, 'in_progress')
  assert.equal(card.branch, branch)
})

test('файлы вне scope: finish отказывает и не двигает dev', (t) => {
  const { root, db } = repoBoard(t)
  const { cardId, worktree } = taken(root, db)

  commit(worktree, { 'docs/note.md': '# doc\n' }, 'docs change')
  const devHead = runGit(root, ['rev-parse', 'dev'])

  assert.throws(
    () => finishCard(db, { id: cardId, actor: 'developer', summary: 'x', root }),
    /scope/,
  )
  assert.equal(runGit(root, ['rev-parse', 'dev']), devHead, 'dev не сдвинулся')
  assert.equal(getCard(db, cardId)!.status, 'in_progress')
})

test('finish ставит review при review_required и done иначе', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  const review = seedCard(db, { phase: 'task', status: 'in_progress', position: 1 })
  editCard(db, { id: review.id, actor: 'owner', patch: { needsMerge: false, reviewRequired: true } })
  db.prepare("update cards set holder = 'developer' where id = ?").run(review.id)

  const done = seedCard(db, { phase: 'task', status: 'in_progress', position: 2 })
  editCard(db, { id: done.id, actor: 'owner', patch: { needsMerge: false } })
  db.prepare("update cards set holder = 'developer' where id = ?").run(done.id)

  const reviewed = finishCard(db, { id: review.id, actor: 'developer', summary: 'x', root: '' })
  assert.equal(reviewed.status, 'review')
  assert.equal(reviewed.doneAt, null)

  const finished = finishCard(db, { id: done.id, actor: 'developer', summary: 'y', root: '' })
  assert.equal(finished.status, 'done')
  assert.ok(finished.doneAt !== null)
})

test('needs_merge=false пропускает git: нет ветки, worktree и merge-коммита', (t) => {
  const { root, db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  editCard(db, { id: card.id, actor: 'owner', patch: { needsMerge: false } })
  startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })

  const takenCard = takeCard(db, { id: card.id, actor: 'developer', root })
  assert.equal(takenCard.status, 'in_progress')
  assert.equal(takenCard.branch, null)

  const finished = finishCard(db, { id: card.id, actor: 'developer', summary: 'готово', root })
  assert.equal(finished.status, 'done')
  assert.equal(finished.branch, null)
  assert.equal(finished.mergeCommit, null)
  assert.equal(finished.inDev, false)
  assert.equal(existsSync(join(root, '.worktrees')), false)
})

test('finish в review открывает зависимые: waiting → ready', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })

  const first = seedCard(db, { phase: 'task', status: 'in_progress', position: 1 })
  editCard(db, { id: first.id, actor: 'owner', patch: { needsMerge: false, reviewRequired: true } })
  db.prepare("update cards set holder = 'developer' where id = ?").run(first.id)

  const dependent = seedCard(db, { phase: 'task', status: 'waiting', position: 2 })
  editCard(db, { id: dependent.id, actor: 'owner', patch: { needsMerge: false } })
  addDep(db, dependent.id, first.id)

  const finished = finishCard(db, { id: first.id, actor: 'developer', summary: 'x', root: '' })
  assert.equal(finished.status, 'review')
  assert.equal(getCard(db, dependent.id)!.status, 'ready')
})

test('finish --no-merge находит merge-коммит ветки и не мержит повторно', (t) => {
  const { root, db } = repoBoard(t)
  const { cardId, branch, worktree } = taken(root, db)

  commit(worktree, { 'src/app.ts': 'export const x = 1\n' }, 'add app')

  // Агент влил ветку в dev вручную (нестандартный мерж) и вернулся на main.
  runGit(root, ['checkout', 'dev'])
  runGit(root, ['merge', '--no-ff', branch, '-m', 'manual merge'])
  runGit(root, ['checkout', 'main'])
  const devHead = runGit(root, ['rev-parse', 'dev'])

  const finished = finishCard(db, {
    id: cardId,
    actor: 'developer',
    summary: 'готово',
    root,
    noMerge: true,
  })
  assert.equal(finished.status, 'done')
  assert.ok(finished.mergeCommit !== null)
  assert.equal(finished.inDev, true)
  assert.equal(runGit(root, ['rev-parse', 'dev']), devHead, 'dev не менялся')
})

test('touch продлевает lease карточки и забега на два часа', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  editCard(db, { id: card.id, actor: 'owner', patch: { needsMerge: false } })
  const run = startRun(db, { executorId: 'developer', cardIds: [card.id], actor: 'developer' })
  db.prepare("update cards set status = 'in_progress' where id = ?").run(card.id)
  db.prepare("update runs set lease_until = '2000-01-01T00:00:00.000Z' where id = ?").run(run.id)

  const touched = touchCard(db, { id: card.id, actor: 'developer' })
  assert.ok(touched.leaseUntil! > '2000-01-01T00:00:00.000Z')
  assert.equal(getActiveRun(db, 'developer')!.leaseUntil, touched.leaseUntil)
})

test('block помечает run_cards blocked: run next пропускает, run end снимает', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  const second = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  const run = startRun(db, { executorId: 'developer', cardIds: [first.id, second.id], actor: 'developer' })

  db.prepare("update cards set status = 'in_progress' where id = ?").run(first.id)
  db.prepare("update run_cards set status = 'in_progress' where run_id = ? and card_id = ?").run(
    run.id,
    first.id,
  )

  const blocked = blockCard(db, { id: first.id, actor: 'developer', reason: 'needs_decision', note: '?' })
  assert.equal(blocked.status, 'blocked')
  assert.equal(listRunCards(db, run.id).find((row) => row.cardId === first.id)!.status, 'blocked')

  assert.equal(nextCard(db, { executorId: 'developer' })!.id, second.id)

  endRun(db, { executorId: 'developer', actor: 'developer' })
  assert.equal(listRunCards(db, run.id).find((row) => row.cardId === first.id)!.status, 'dropped')
})

test('take отказывает, пока в забеге есть карточка в работе, и пускает после block', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  const second = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  editCard(db, { id: first.id, actor: 'owner', patch: { needsMerge: false } })
  editCard(db, { id: second.id, actor: 'owner', patch: { needsMerge: false } })
  startRun(db, { executorId: 'developer', cardIds: [first.id, second.id], actor: 'developer' })

  takeCard(db, { id: first.id, actor: 'developer', root: '' })
  assert.throws(
    () => takeCard(db, { id: second.id, actor: 'developer', root: '' }),
    /в работе/,
  )

  blockCard(db, { id: first.id, actor: 'developer', reason: 'needs_decision' })
  assert.equal(takeCard(db, { id: second.id, actor: 'developer', root: '' }).status, 'in_progress')
})

test('после finish первой карточки вторая берётся', (t) => {
  const { db } = board(t)
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const first = seedCard(db, { phase: 'task', status: 'ready', position: 1 })
  const second = seedCard(db, { phase: 'task', status: 'ready', position: 2 })
  editCard(db, { id: first.id, actor: 'owner', patch: { needsMerge: false } })
  editCard(db, { id: second.id, actor: 'owner', patch: { needsMerge: false } })
  startRun(db, { executorId: 'developer', cardIds: [first.id, second.id], actor: 'developer' })

  takeCard(db, { id: first.id, actor: 'developer', root: '' })
  finishCard(db, { id: first.id, actor: 'developer', summary: 'готово', root: '' })

  assert.equal(takeCard(db, { id: second.id, actor: 'developer', root: '' }).status, 'in_progress')
})

test('finish отказывает, если общий worktree не на ветке карточки, и не мержит', (t) => {
  const { root, db } = repoBoard(t)
  const { cardId, branch, worktree } = taken(root, db)

  // Общий worktree переключён на другую ветку (dev): finish карточки на card/<id>
  // не должен молча делать sync с dev в чужой ветке.
  runGit(worktree, ['checkout', 'dev'])
  const devHead = runGit(root, ['rev-parse', 'dev'])

  assert.throws(
    () => finishCard(db, { id: cardId, actor: 'developer', summary: 'x', root }),
    /ветке/,
  )
  assert.equal(getCard(db, cardId)!.status, 'in_progress')
  assert.equal(getCard(db, cardId)!.branch, branch)
  assert.equal(runGit(root, ['rev-parse', 'dev']), devHead, 'dev не сдвинулся')
})
