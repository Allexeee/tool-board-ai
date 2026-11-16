import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { addFeature, getFeature } from '../../src/core/features.ts'
import { currentBranch } from '../../src/core/git/git.ts'
import { startFeature } from '../../src/core/git/worktree.ts'

function fixture() {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))
  const feature = addFeature(db, { name: 'Оплата подписки', rank: 1 })
  return { root, db, config, feature }
}

test('feature start создаёт ветку и рабочий каталог', () => {
  const { root, db, config, feature } = fixture()
  const result = startFeature(db, { root, featureId: feature.id, config })

  assert.equal(result.branch, 'feat/f1-oplata-podpiski')
  assert.ok(existsSync(join(result.worktree, '.git')))
  assert.equal(currentBranch(result.worktree), result.branch)
  assert.equal(getFeature(db, feature.id)!.branch, result.branch)
})

test('повторный feature start возвращает то же и не ломается', () => {
  const { root, db, config, feature } = fixture()
  const first = startFeature(db, { root, featureId: feature.id, config })
  const second = startFeature(db, { root, featureId: feature.id, config })
  assert.deepEqual(second, first)
})
