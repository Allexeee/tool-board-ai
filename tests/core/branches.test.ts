import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { resolveBranches, runGit } from '../../src/core/git.ts'
import { initProject } from '../../src/core/project.ts'
import { readSettings, updateSettings } from '../../src/core/settings.ts'
import { makeRepo } from '../helpers/repo.ts'

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
