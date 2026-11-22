import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCard } from '../../src/core/cards.ts'
import {
  ensureWorktree,
  findLocalBoardCli,
  isBoardSourceRepo,
  isAncestor,
  isRepo,
  mergeCommitFor,
  mergeToDev,
  outOfScope,
  releaseToMain,
  resolveBranches,
  revertMerge,
  runGit,
  startCardBranch,
  syncWithDev,
} from '../../src/core/git.ts'
import { getRun, reclaimExpired } from '../../src/core/runs.ts'
import { makeBoard, seedCard, seedExecutor, seedRun } from '../helpers/board.ts'
import { makeRepo } from '../helpers/repo.ts'

test('isRepo и resolveBranches', (t) => {
  const repo = makeRepo()
  t.after(repo.close)

  assert.equal(isRepo(repo.root), true)
  assert.equal(isRepo(join(repo.root, 'нет-такого-каталога')), false)
  assert.deepEqual(resolveBranches(repo.root), { main: 'main', dev: 'dev' })
})

test('полный цикл: ветка, scope, merge в dev, mergeCommitFor и release в main', (t) => {
  const boardFixture = makeBoard()
  t.after(boardFixture.close)
  const { db } = boardFixture
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev' })

  const repo = makeRepo()
  t.after(repo.close)
  const root = repo.root

  const wt = ensureWorktree(root, 'developer')
  const { branch } = startCardBranch(root, 'developer', card)
  assert.equal(branch, 'card/UI-1')

  mkdirSync(join(wt, 'src'), { recursive: true })
  writeFileSync(join(wt, 'src', 'a.ts'), 'export const a = 1\n')
  runGit(wt, ['add', '.'])
  runGit(wt, ['commit', '-m', 'UI-1'])

  assert.deepEqual(outOfScope(root, branch, ['src/**']), [])

  const merge = mergeToDev(root, branch, 'UI-1')
  assert.ok(merge.length > 0)
  assert.equal(mergeCommitFor(root, branch), merge)
  assert.equal(isAncestor(root, merge, 'dev'), true)
  assert.equal(isAncestor(root, merge, 'main'), false)

  const release = releaseToMain(root)
  assert.equal(isAncestor(root, merge, 'main'), true)
  assert.equal(isAncestor(root, release, 'main'), true)
})

test('startCardBranch отказывает в грязном worktree', (t) => {
  const boardFixture = makeBoard()
  t.after(boardFixture.close)
  const card = seedCard(boardFixture.db, { phase: 'task', status: 'booked', skill: 'dev' })

  const repo = makeRepo()
  t.after(repo.close)

  const wt = ensureWorktree(repo.root, 'developer')
  writeFileSync(join(wt, 'dirty.txt'), 'x\n')

  assert.throws(() => startCardBranch(repo.root, 'developer', card), /грязное/)
})

test('повторная попытка получает ветку card/<ID>-<attempt>', (t) => {
  const boardFixture = makeBoard()
  t.after(boardFixture.close)
  const { db } = boardFixture
  const card = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev' })
  db.prepare('update cards set attempt = 2 where id = ?').run(card.id)
  const attempt2 = getCard(db, card.id)!

  const repo = makeRepo()
  t.after(repo.close)

  const { branch } = startCardBranch(repo.root, 'developer', attempt2)
  assert.equal(branch, 'card/UI-1-2')
})

test('syncWithDev прерывает конфликт и оставляет ветку карточки', (t) => {
  const boardFixture = makeBoard()
  t.after(boardFixture.close)
  const card = seedCard(boardFixture.db, { phase: 'task', status: 'booked', skill: 'dev' })

  const repo = makeRepo()
  t.after(repo.close)
  const root = repo.root

  runGit(root, ['checkout', 'dev'])
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'a.ts'), 'dev base\n')
  runGit(root, ['add', '.'])
  runGit(root, ['commit', '-m', 'base'])
  runGit(root, ['checkout', 'main'])

  const wt = ensureWorktree(root, 'developer')
  const { branch } = startCardBranch(root, 'developer', card)

  writeFileSync(join(wt, 'src', 'a.ts'), 'card version\n')
  runGit(wt, ['add', '.'])
  runGit(wt, ['commit', '-m', 'card change'])

  runGit(root, ['checkout', 'dev'])
  writeFileSync(join(root, 'src', 'a.ts'), 'dev version\n')
  runGit(root, ['add', '.'])
  runGit(root, ['commit', '-m', 'dev change'])
  runGit(root, ['checkout', 'main'])

  assert.throws(() => syncWithDev(root, wt, branch), /src\/a\.ts/)
  assert.equal(runGit(wt, ['symbolic-ref', '--short', 'HEAD']), branch)
})

test('outOfScope находит файлы вне scope', (t) => {
  const boardFixture = makeBoard()
  t.after(boardFixture.close)
  const card = seedCard(boardFixture.db, { phase: 'task', status: 'booked', skill: 'dev' })

  const repo = makeRepo()
  t.after(repo.close)
  const root = repo.root

  const wt = ensureWorktree(root, 'developer')
  const { branch } = startCardBranch(root, 'developer', card)

  mkdirSync(join(wt, 'src'), { recursive: true })
  mkdirSync(join(wt, 'docs'), { recursive: true })
  writeFileSync(join(wt, 'src', 'a.ts'), 'a\n')
  writeFileSync(join(wt, 'docs', 'evil.txt'), 'evil\n')
  runGit(wt, ['add', '.'])
  runGit(wt, ['commit', '-m', 'mixed'])

  assert.deepEqual(outOfScope(root, branch, ['src/**']), ['docs/evil.txt'])
})

test('revertMerge создаёт revert-коммит в dev', (t) => {
  const boardFixture = makeBoard()
  t.after(boardFixture.close)
  const card = seedCard(boardFixture.db, { phase: 'task', status: 'booked', skill: 'dev' })

  const repo = makeRepo()
  t.after(repo.close)
  const root = repo.root

  const wt = ensureWorktree(root, 'developer')
  const { branch } = startCardBranch(root, 'developer', card)
  mkdirSync(join(wt, 'src'), { recursive: true })
  writeFileSync(join(wt, 'src', 'a.ts'), 'a\n')
  runGit(wt, ['add', '.'])
  runGit(wt, ['commit', '-m', 'UI-1'])

  const merge = mergeToDev(root, branch, 'UI-1')
  const revert = revertMerge(root, merge)

  assert.ok(revert.length > 0)
  assert.equal(isAncestor(root, revert, 'dev'), true)
  assert.equal(mergeCommitFor(root, branch), merge, 'merge-коммит остаётся в истории')
  assert.equal(runGit(root, ['ls-tree', 'dev', 'src/a.ts']), '', 'файл карточки откачен из dev')
})

test('истёкший lease освобождает карточку, но не трогает worktree и ветку', (t) => {
  const boardFixture = makeBoard()
  t.after(boardFixture.close)
  const { db } = boardFixture
  seedExecutor(db, { id: 'developer', skills: ['dev'] })
  const card = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev' })

  const repo = makeRepo()
  t.after(repo.close)
  const root = repo.root

  const { branch, worktree } = startCardBranch(root, 'developer', card)
  assert.equal(branch, 'card/UI-1')

  const run = seedRun(db, {
    executorId: 'developer',
    cardIds: [card.id],
    leaseUntil: '2000-01-01T00:00:00.000Z',
  })

  assert.equal(reclaimExpired(db), 1)
  assert.equal(getRun(db, run.id)!.status, 'lease_expired')
  assert.equal(getCard(db, card.id)!.status, 'ready')

  assert.equal(existsSync(worktree), true)
  assert.doesNotThrow(() => runGit(root, ['rev-parse', '--verify', branch]))
})

test('ensureWorktree переиспользует зарегистрированный worktree', (t) => {
  const repo = makeRepo()
  t.after(repo.close)

  const first = ensureWorktree(repo.root, 'developer')
  const second = ensureWorktree(repo.root, 'developer')

  assert.equal(first, second)
  assert.equal(existsSync(first), true)
})

test('ensureWorktree отказывает, если каталог занят посторонними файлами', (t) => {
  const repo = makeRepo()
  t.after(repo.close)

  const dir = join(repo.root, '.worktrees', 'developer')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'stray.txt'), 'x\n')

  assert.throws(
    () => ensureWorktree(repo.root, 'developer'),
    /занят посторонними файлами/,
  )
})

test('mergeCommitFor находит merge-коммит своей ветки при нескольких мержах', (t) => {
  const boardFixture = makeBoard()
  t.after(boardFixture.close)
  const { db } = boardFixture
  const cardA = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev' })
  const cardB = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev' })

  const repo = makeRepo()
  t.after(repo.close)
  const root = repo.root

  const wtA = ensureWorktree(root, 'developer-a')
  const { branch: branchA } = startCardBranch(root, 'developer-a', cardA)
  mkdirSync(join(wtA, 'src'), { recursive: true })
  writeFileSync(join(wtA, 'src', 'a.ts'), 'a\n')
  runGit(wtA, ['add', '.'])
  runGit(wtA, ['commit', '-m', 'A'])
  const mergeA = mergeToDev(root, branchA, 'A')

  const wtB = ensureWorktree(root, 'developer-b')
  const { branch: branchB } = startCardBranch(root, 'developer-b', cardB)
  mkdirSync(join(wtB, 'src'), { recursive: true })
  writeFileSync(join(wtB, 'src', 'b.ts'), 'b\n')
  runGit(wtB, ['add', '.'])
  runGit(wtB, ['commit', '-m', 'B'])
  const mergeB = mergeToDev(root, branchB, 'B')

  assert.notEqual(mergeA, mergeB)
  assert.equal(mergeCommitFor(root, branchA), mergeA)
  assert.equal(mergeCommitFor(root, branchB), mergeB)
})

test('findLocalBoardCli ������� tools/board � �� ������ ����� bin', (t) => {
  const repo = makeRepo()
  t.after(repo.close)

  mkdirSync(join(repo.root, 'tools', 'board', 'bin'), { recursive: true })
  writeFileSync(join(repo.root, 'tools', 'board', 'bin', 'board.ts'), '')
  assert.match(findLocalBoardCli(repo.root)!, /tools[\\/]board[\\/]bin[\\/]board\.ts$/)
  assert.equal(isBoardSourceRepo(repo.root), false)

  const other = makeRepo()
  t.after(other.close)
  mkdirSync(join(other.root, 'bin'), { recursive: true })
  writeFileSync(join(other.root, 'bin', 'board.ts'), '')
  assert.equal(findLocalBoardCli(other.root), null)
})

test('isBoardSourceRepo ����� ����������� board', (t) => {
  const repo = makeRepo()
  t.after(repo.close)

  mkdirSync(join(repo.root, 'bin'), { recursive: true })
  mkdirSync(join(repo.root, 'src', 'core'), { recursive: true })
  writeFileSync(join(repo.root, 'package.json'), JSON.stringify({ name: 'tool-board-ai' }))
  writeFileSync(join(repo.root, 'bin', 'board.ts'), '')
  writeFileSync(join(repo.root, 'src', 'core', 'now.ts'), '')

  assert.equal(isBoardSourceRepo(repo.root), true)
  assert.match(findLocalBoardCli(repo.root)!, /bin[\\/]board\.ts$/)
})
