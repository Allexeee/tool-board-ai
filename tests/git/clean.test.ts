import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { abandonFeature, addFeature, getFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { cleanFeature } from '../../src/core/git/clean.ts'
import { branchExists, runGit } from '../../src/core/git/git.ts'

function cancelledFixture() {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))

  const feature = addFeature(db, { name: 'Оплата', rank: 1 })
  addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  const { worktree, branch } = startFeature(db, { root, featureId: feature.id, config })
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', 'a.ts'), 'a')

  abandonFeature(db, { featureId: feature.id, actor: 'owner', reason: 'передумали' })

  return { root, db, config, feature, worktree, branch }
}

test('feature clean убирает каталог и оставляет ветку', () => {
  const { root, db, config, feature, worktree, branch } = cancelledFixture()

  const result = cleanFeature(db, { featureId: feature.id, root, branch: false, config, actor: 'owner' })

  assert.equal(result.removed, true)
  assert.equal(result.branchDeleted, false)
  assert.equal(existsSync(worktree), false)
  assert.equal(getFeature(db, feature.id)!.worktree, null)
  assert.equal(branchExists(root, branch), true)
})

test('feature clean --branch ставит тег archive и удаляет невлитую ветку', () => {
  const { root, db, config, feature, worktree, branch } = cancelledFixture()

  const result = cleanFeature(db, { featureId: feature.id, root, branch: true, config, actor: 'owner' })

  assert.equal(result.branchDeleted, true)
  assert.equal(existsSync(worktree), false)
  assert.equal(branchExists(root, branch), false)
  assert.match(runGit(root, ['tag', '--list', 'archive/*']), /archive\//)
  assert.equal(getFeature(db, feature.id)!.branch, null)
})

test('feature clean не трогает незакрытую фичу', () => {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))

  const feature = addFeature(db, { name: 'Оплата', rank: 1 })
  addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  const { worktree } = startFeature(db, { root, featureId: feature.id, config })

  assert.throws(
    () => cleanFeature(db, { featureId: feature.id, root, branch: false, config, actor: 'owner' }),
    /не трогает незакрытые/,
  )
  assert.equal(existsSync(worktree), true)
})
