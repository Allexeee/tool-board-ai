import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveBranches, runGit, isAncestor } from '../../src/core/git.ts'
import { initProject } from '../../src/core/project.ts'
import { readSettings, updateSettings } from '../../src/core/settings.ts'
import { makeRepo, commitGenerated } from '../helpers/repo.ts'
import { openDb } from '../../src/core/db.ts'
import { seedCard as seed, seedExecutor } from '../helpers/board.ts'
import { takeCard, finishCard } from '../../src/core/lifecycle.ts'
import { mkdirSync, writeFileSync } from 'node:fs'

test('resolveBranches: по умолчанию main и dev', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  initProject(repo.root)

  assert.deepEqual(resolveBranches(repo.root), { main: 'main', dev: 'dev' })
})

test('resolveBranches: master и develop определяются по git', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  runGit(repo.root, ['branch', '-m', 'main', 'master'])
  runGit(repo.root, ['branch', '-m', 'dev', 'develop'])
  initProject(repo.root)

  assert.deepEqual(resolveBranches(repo.root), { main: 'master', dev: 'develop' })
})

test('resolveBranches: настройка важнее автодетекта, пустая — снова авто', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  initProject(repo.root)

  updateSettings(repo.root, { branches: { main: 'trunk', dev: 'integration' } })
  assert.deepEqual(resolveBranches(repo.root), { main: 'trunk', dev: 'integration' })

  updateSettings(repo.root, { branches: { main: '', dev: '' } })
  assert.deepEqual(resolveBranches(repo.root), { main: 'main', dev: 'dev' })
})

test('settings: branches по умолчанию null и пишутся в файл', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  initProject(repo.root)

  assert.deepEqual(readSettings(repo.root).branches, { main: null, dev: null })

  const next = updateSettings(repo.root, { branches: { main: 'trunk' } })
  assert.deepEqual(next.branches, { main: 'trunk', dev: null })
  assert.ok(join(repo.root, '.board', 'settings.json').length > 0)
})

test('master/develop: take и finish мержат в develop', (t) => {
  const repo = makeRepo()
  t.after(() => repo.close())
  runGit(repo.root, ['branch', '-m', 'main', 'master'])
  runGit(repo.root, ['branch', '-m', 'dev', 'develop'])
  initProject(repo.root)
  commitGenerated(repo.root)

  const db = openDb(join(repo.root, '.board', 'board.db'))
  try {
    seedExecutor(db, { id: 'developer', skills: ['dev'] })
    const card = seed(db, { phase: 'task', status: 'ready', scope: ['src/**'] })

    takeCard(db, { id: card.id, actor: 'developer', root: repo.root })
    const worktree = join(repo.root, '.worktrees', 'developer')
    mkdirSync(join(worktree, 'src'), { recursive: true })
    writeFileSync(join(worktree, 'src', `${card.id}.txt`), 'x\n')
    runGit(worktree, ['add', '.'])
    runGit(worktree, ['commit', '-m', card.id])

    const finished = finishCard(db, {
      id: card.id,
      actor: 'developer',
      summary: 'готово',
      root: repo.root,
    })
    assert.equal(finished.status, 'done')
    assert.equal(finished.inDev, true)
    assert.equal(isAncestor(repo.root, finished.mergeCommit!, 'develop'), true)
  } finally {
    db.close()
  }
})
