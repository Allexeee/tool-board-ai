import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { abandonFeature, addFeature, getFeature } from '../../src/core/features.ts'
import { currentBranch, runGit } from '../../src/core/git/git.ts'
import { cleanFeature } from '../../src/core/git/clean.ts'
import { slotPath, startFeature } from '../../src/core/git/worktree.ts'

function fixture(options: { pool?: number } = {}) {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = {
    ...readConfig(join(root, '.toolbox-al/config.json')),
    worktreePool: options.pool ?? 2,
  }
  const feature = addFeature(db, { name: 'Оплата подписки', rank: 1 })
  return { root, db, config, feature }
}

test('feature start берёт слот пула и создаёт ветку от dev', () => {
  const { root, db, config, feature } = fixture()
  const devHead = runGit(root, ['rev-parse', 'dev'])

  const result = startFeature(db, { root, featureId: feature.id, config })

  assert.equal(result.branch, 'feat/f1-oplata-podpiski')
  assert.equal(result.worktree, slotPath(root, 1))
  assert.ok(existsSync(join(result.worktree, '.git')))
  assert.equal(currentBranch(result.worktree), result.branch)
  assert.equal(runGit(result.worktree, ['rev-parse', 'HEAD']), devHead, 'ветка начата от dev')
  assert.equal(getFeature(db, feature.id)!.branch, result.branch)
  assert.equal(getFeature(db, feature.id)!.worktree, slotPath(root, 1))
})

test('повторный feature start возвращает то же и не ломается', () => {
  const { root, db, config, feature } = fixture()
  const first = startFeature(db, { root, featureId: feature.id, config })
  const second = startFeature(db, { root, featureId: feature.id, config })
  assert.deepEqual(second, first)
})

test('после clean слот достаётся следующей фиче и не тащит чужую грязь', () => {
  const { root, db, config, feature } = fixture()

  const first = startFeature(db, { root, featureId: feature.id, config })
  writeFileSync(join(first.worktree, 'черновик.txt'), 'недоделка')

  abandonFeature(db, { featureId: feature.id, actor: 'owner', reason: 'передумали' })
  cleanFeature(db, { featureId: feature.id, root, branch: false, config, actor: 'owner' })

  // слот вернулся в пул: голова на dev, рабочая копия чистая
  assert.equal(existsSync(first.worktree), true)
  assert.equal(currentBranch(first.worktree), 'dev')
  assert.equal(existsSync(join(first.worktree, 'черновик.txt')), false)

  const second = addFeature(db, { name: 'Вторая фича', rank: 2 })
  const result = startFeature(db, { root, featureId: second.id, config })

  assert.equal(result.worktree, first.worktree, 'каталог переиспользован, а не создан заново')
  assert.equal(currentBranch(result.worktree), result.branch)
  assert.equal(existsSync(join(result.worktree, 'черновик.txt')), false)
})

test('заполненный пул отказывает и говорит, что делать', () => {
  const { root, db, config, feature } = fixture({ pool: 1 })
  startFeature(db, { root, featureId: feature.id, config })

  const second = addFeature(db, { name: 'Вторая фича', rank: 2 })
  assert.throws(
    () => startFeature(db, { root, featureId: second.id, config }),
    (error: unknown) =>
      (error as { code?: number }).code === 1 &&
      /все слоты заняты/.test((error as Error).message) &&
      /feature clean/.test((error as Error).message) &&
      /worktreePool/.test((error as Error).message),
  )
})

test('worktreePool: 0 — свой каталог на фичу, как раньше', () => {
  const { root, db, config, feature } = fixture({ pool: 0 })

  const result = startFeature(db, { root, featureId: feature.id, config })

  assert.equal(result.worktree, join(root, '.worktrees', 'f1-oplata-podpiski'))
  assert.equal(currentBranch(result.worktree), result.branch)
})

test('размер пула задаётся в конфиге, по умолчанию два слота', () => {
  const root = makeRepoWithDev()
  initProject(root)
  const path = join(root, '.toolbox-al', 'config.json')

  assert.equal(readConfig(path).worktreePool, 2, 'по умолчанию два слота')

  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  writeFileSync(path, JSON.stringify({ ...raw, worktreePool: 1 }), 'utf8')
  assert.equal(readConfig(path).worktreePool, 1)
})
