import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit, isRepo, currentBranch, branchExists, resolveBranches } from '../../src/core/git/git.ts'
import { makeRepo } from '../helpers/repo.ts'

const config = { branches: { main: 'main', dev: 'dev' } }

test('resolveBranches берёт develop, если есть только он', () => {
  const dir = makeRepo()
  runGit(dir, ['branch', 'develop'])
  assert.deepEqual(resolveBranches(dir, config), { main: 'main', dev: 'develop' })
})

test('resolveBranches оставляет dev, если он есть', () => {
  const dir = makeRepo()
  runGit(dir, ['branch', 'dev'])
  assert.deepEqual(resolveBranches(dir, config), { main: 'main', dev: 'dev' })
})

test('не-репозиторий даёт понятную ошибку', () => {
  const dir = mkdtempSync(join(tmpdir(), 'norepo-'))
  assert.equal(isRepo(dir), false)
  assert.throws(() => runGit(dir, ['status']), /не git-репозиторий/)
})

test('currentBranch возвращает имя ветки', () => {
  const dir = makeRepo()
  assert.equal(currentBranch(dir), 'main')
  assert.equal(branchExists(dir, 'dev'), false)
  assert.equal(branchExists(dir, 'main'), true)
})
