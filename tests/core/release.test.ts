import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { getCard } from '../../src/core/cards.ts'
import { openDb } from '../../src/core/db.ts'
import {
  isAncestor,
  mergeToDev,
  refreshMergeState,
  runGit,
  startCardBranch,
} from '../../src/core/git.ts'
import { cancelCard, finishCard } from '../../src/core/lifecycle.ts'
import { initProject } from '../../src/core/project.ts'
import { release } from '../../src/core/release.ts'
import { waiveReview } from '../../src/core/review.ts'
import { updateSettings } from '../../src/core/settings.ts'
import type { Card } from '../../src/core/types.ts'
import { seedCard } from '../helpers/board.ts'
import { commitGenerated, makeRepo } from '../helpers/repo.ts'

interface RepoBoard {
  root: string
  db: DatabaseSync
}

/** Доска внутри временного git-репозитория: release и revert трогают dev/main. */
function repoBoard(t: { after: (fn: () => void) => void }): RepoBoard {
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

/**
 * Реальный merge карточки в dev: ветка, коммит, mergeToDev. Возвращает карточку
 * с `merge_commit` и `in_dev=1` в нужном статусе.
 */
function merged(root: string, db: DatabaseSync, status: Card['status'], executor: string): Card {
  const card = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev' })
  const { branch, worktree } = startCardBranch(root, executor, card)
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', `${card.id}.txt`), `${card.id}\n`)
  runGit(worktree, ['add', '.'])
  runGit(worktree, ['commit', '-m', card.id])
  const merge = mergeToDev(root, branch, card.id)
  db.prepare('update cards set status = ?, merge_commit = ?, in_dev = 1, in_main = 0 where id = ?').run(
    status,
    merge,
    card.id,
  )
  if (status === 'done') {
    waiveReview(db, { cardId: card.id, actor: 'owner', reason: 'test: release-гейт' })
  }
  return getCard(db, card.id)!
}

test('release блокируется на карточке в dev не в done и обновляет in_main после done', (t) => {
  const { root, db } = repoBoard(t)
  const done = merged(root, db, 'done', 'dev-a')
  const review = merged(root, db, 'review', 'dev-b')

  assert.throws(() => release(db, root, 'owner'), /не done/)

  db.prepare("update cards set status = 'done' where id = ?").run(review.id)
  waiveReview(db, { cardId: review.id, actor: 'owner', reason: 'test: release-гейт' })

  const result = release(db, root, 'owner')
  assert.equal(result.commit.length, 40)
  assert.equal(getCard(db, done.id)!.inMain, true)
  assert.equal(getCard(db, review.id)!.inMain, true)
})

test('release блокируется на done без ревью и waiver', (t) => {
  const { root, db } = repoBoard(t)
  const card = merged(root, db, 'done', 'dev-a')
  db.prepare("delete from events where subject = ? and type = 'card.review_waived'").run(card.id)

  assert.throws(() => release(db, root, 'owner'), /нет ревью/)
})

test('профиль high блокирует открытый important', (t) => {
  const { root, db } = repoBoard(t)
  merged(root, db, 'done', 'dev-a')
  const important = seedCard(db, { phase: 'request', status: 'new', skill: 'dev' })
  db.prepare("update cards set severity = 'important' where id = ?").run(important.id)
  updateSettings(root, { review: { profile: 'high' } })

  assert.throws(() => release(db, root, 'owner'), /находк/)

  db.prepare("update cards set status = 'done' where id = ?").run(important.id)
  assert.equal(release(db, root, 'owner').commit.length, 40)
})

test('критическая находка блокирует release, пока не закрыта', (t) => {
  const { root, db } = repoBoard(t)
  merged(root, db, 'done', 'dev-a')
  const critical = seedCard(db, { phase: 'request', status: 'new', skill: 'dev' })
  db.prepare("update cards set severity = 'critical' where id = ?").run(critical.id)

  assert.throws(() => release(db, root, 'owner'), /находк/)

  db.prepare("update cards set status = 'done' where id = ?").run(critical.id)
  assert.equal(release(db, root, 'owner').commit.length, 40)
})

test('needs_merge=false в review не блокирует release', (t) => {
  const { root, db } = repoBoard(t)
  merged(root, db, 'done', 'dev-a')
  const noMerge = seedCard(db, { phase: 'task', status: 'review', skill: 'dev' })
  db.prepare('update cards set needs_merge = 0 where id = ?').run(noMerge.id)

  assert.equal(release(db, root, 'owner').commit.length, 40)
})

test('cancel с root создаёт revert-коммит, и release после этого проходит', (t) => {
  const { root, db } = repoBoard(t)
  const card = merged(root, db, 'done', 'dev-a')

  const cancelled = cancelCard(db, { id: card.id, actor: 'owner', reason: 'не нужно', root })
  assert.equal(cancelled.status, 'cancelled')
  assert.ok(cancelled.revertedAt !== null)
  assert.ok(cancelled.revertCommit !== null)
  assert.equal(isAncestor(root, cancelled.revertCommit!, 'dev'), true)

  // reverted_at снимает карточку из release-гейта
  const result = release(db, root, 'owner')
  assert.equal(result.commit.length, 40)
})

test('конфликт revert оставляет карточку без изменений', (t) => {
  const { root, db } = repoBoard(t)
  const a = merged(root, db, 'done', 'dev-a')

  // B меняет файл, который создал A: revert A конфликтует с B.
  const bCard = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev' })
  const { branch, worktree } = startCardBranch(root, 'dev-b', bCard)
  writeFileSync(join(worktree, 'src', `${a.id}.txt`), 'changed\n')
  runGit(worktree, ['add', '.'])
  runGit(worktree, ['commit', '-m', 'B'])
  mergeToDev(root, branch, 'B')

  const before = getCard(db, a.id)!
  assert.throws(
    () => cancelCard(db, { id: a.id, actor: 'owner', reason: 'передумал', root }),
    /конфликт revert|revert/,
  )
  const after = getCard(db, a.id)!
  assert.equal(after.status, before.status)
  assert.equal(after.revertedAt, null)
  assert.equal(after.revertCommit, null)
})

test('release доступен только владельцу', (t) => {
  const { root, db } = repoBoard(t)
  merged(root, db, 'done', 'dev-a')

  assert.throws(() => release(db, root, 'developer'), /владельц/)
})

test('refreshMergeState без merge_commit ставит in_dev/in_main в false', (t) => {
  const { root, db } = repoBoard(t)
  const card = seedCard(db, { phase: 'task', status: 'done', skill: 'dev' })
  db.prepare('update cards set needs_merge = 0 where id = ?').run(card.id)

  const refreshed = refreshMergeState(db, root, getCard(db, card.id)!)
  assert.equal(refreshed.inDev, false)
  assert.equal(refreshed.inMain, false)
})

test('release блокирует карточку review с кодом в dev, даже если in_dev=0', (t) => {
  const { root, db } = repoBoard(t)
  const review = merged(root, db, 'review', 'dev-a')
  db.prepare('update cards set in_dev = 0 where id = ?').run(review.id)

  assert.throws(() => release(db, root, 'owner'), /не done/)
  assert.equal(getCard(db, review.id)!.inDev, true)
})

test('release не блокируется ложным in_dev: коммит не в dev', (t) => {
  const { root, db } = repoBoard(t)
  merged(root, db, 'done', 'dev-a')

  const card = seedCard(db, {
    phase: 'task',
    status: 'booked',
    skill: 'dev',
    scope: ['src/**'],
  })
  const { branch, worktree } = startCardBranch(root, 'dev-x', card)
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', `${card.id}.txt`), 'x\n')
  runGit(worktree, ['add', '.'])
  runGit(worktree, ['commit', '-m', card.id])
  const commit = runGit(worktree, ['rev-parse', 'HEAD'])
  db.prepare('update cards set status = ?, branch = ?, merge_commit = ?, in_dev = 1 where id = ?').run(
    'review',
    branch,
    commit,
    card.id,
  )

  assert.equal(release(db, root, 'owner').commit.length, 40)
  assert.equal(getCard(db, card.id)!.inDev, false)
})

test('повторный finish на уже слитой карточке не мержит второй раз', (t) => {
  const { root, db } = repoBoard(t)
  const card = seedCard(db, {
    phase: 'task',
    status: 'booked',
    skill: 'dev',
    scope: ['src/**'],
  })
  const { branch, worktree } = startCardBranch(root, 'developer', card)
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', `${card.id}.txt`), 'x\n')
  runGit(worktree, ['add', '.'])
  runGit(worktree, ['commit', '-m', card.id])
  const merge = mergeToDev(root, branch, card.id)

  // Падение между git и БД: merge уже в dev, карточка ещё в работе без merge_commit.
  db.prepare(
    "update cards set status = 'in_progress', holder = 'developer', branch = ?, needs_merge = 1 where id = ?",
  ).run(branch, card.id)
  const before = runGit(root, ['rev-list', '--merges', '--count', 'dev'])

  const finished = finishCard(db, { id: card.id, actor: 'developer', summary: 'готово', root })
  assert.equal(finished.mergeCommit, merge)
  assert.equal(finished.inDev, true)
  assert.equal(finished.status, 'done')
  assert.equal(runGit(root, ['rev-list', '--merges', '--count', 'dev']), before)
})

test('finish с merge_commit вне dev даёт ошибку рассинхрона', (t) => {
  const { root, db } = repoBoard(t)
  const card = seedCard(db, {
    phase: 'task',
    status: 'booked',
    skill: 'dev',
    scope: ['src/**'],
  })
  const { branch, worktree } = startCardBranch(root, 'developer', card)
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', `${card.id}.txt`), 'x\n')
  runGit(worktree, ['add', '.'])
  runGit(worktree, ['commit', '-m', card.id])
  const commit = runGit(worktree, ['rev-parse', 'HEAD'])

  db.prepare(
    "update cards set status = 'in_progress', holder = 'developer', branch = ?, needs_merge = 1, merge_commit = ? where id = ?",
  ).run(branch, commit, card.id)

  assert.throws(
    () => finishCard(db, { id: card.id, actor: 'developer', summary: 'готово', root }),
    /рассинхрон/,
  )
})

test('finish после reopen мержит новые коммиты ветки', (t) => {
  const { root, db } = repoBoard(t)
  const card = seedCard(db, {
    phase: 'task',
    status: 'booked',
    skill: 'dev',
    scope: ['src/**'],
  })
  const { branch, worktree } = startCardBranch(root, 'developer', card)
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', `${card.id}.txt`), '1\n')
  runGit(worktree, ['add', '.'])
  runGit(worktree, ['commit', '-m', 'first'])
  const first = mergeToDev(root, branch, card.id)

  // Reopen: в ветке появился новый коммит, старый merge уже в dev.
  writeFileSync(join(worktree, 'src', `${card.id}.txt`), '2\n')
  runGit(worktree, ['add', '.'])
  runGit(worktree, ['commit', '-m', 'second'])
  const tip = runGit(worktree, ['rev-parse', 'HEAD'])
  db.prepare(
    "update cards set status = 'in_progress', holder = 'developer', branch = ?, needs_merge = 1, merge_commit = ? where id = ?",
  ).run(branch, first, card.id)

  const finished = finishCard(db, { id: card.id, actor: 'developer', summary: 'готово', root })
  assert.notEqual(finished.mergeCommit, first)
  assert.equal(isAncestor(root, tip, 'dev'), true)
})

test('release ставит тег версии, повторный release не падает', (t) => {
  const { root, db } = repoBoard(t)
  merged(root, db, 'done', 'developer')

  const first = release(db, root, 'owner')
  assert.ok(first.commit)

  const version = (
    JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      version: string
    }
  ).version
  const tags = runGit(root, ['tag', '--list'])
  assert.match(tags, new RegExp(`^v${version.replace(/\./g, '\\.')}$`, 'm'))

  const second = release(db, root, 'owner')
  assert.ok(second.commit)
  const after = runGit(root, ['tag', '--list']).trim().split('\n').filter(Boolean)
  assert.equal(after.filter((tag) => tag === `v${version}`).length, 1)
})
