import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
import { doneTask } from '../../src/core/done.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { commitTask } from '../../src/core/git/commit.ts'
import { mergeStage } from '../../src/core/git/merge.ts'
import { release } from '../../src/core/git/release.ts'
import { runGit } from '../../src/core/git/git.ts'
import { mkdirSync, writeFileSync } from 'node:fs'

function repoWithMergedStage() {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const feature = addFeature(db, { name: 'Оплата', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'Каркас', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  const task = createTask(db, {
    stageId: stage.id,
    title: 'Добавить вебхук',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)

  const { worktree } = startFeature(db, { root, featureId: feature.id, config })
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  takeTask(db, { executor: 'w1', taskId: task.id })
  commitTask({ worktree, task, report: { summary: 'готово', checks: [] } })
  doneTask(db, { taskId: task.id, executor: 'w1', report: { summary: 'готово', checks: [] } })
  mergeStage(db, { root, stageId: stage.id, config })

  return { db, root, config, stage }
}

test('релиз собирает changelog из этапов и ставит тег', () => {
  const { db, root, config } = repoWithMergedStage()
  const result = release(db, { root, level: 'minor', config, actor: 'owner' })

  assert.equal(result.released, true)
  assert.equal(result.version, '0.2.0')
  assert.equal(result.tag, 'v0.2.0')
  assert.match(result.changelog, /Оплата/)
  assert.match(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), /v0\.2\.0/)
  assert.match(runGit(root, ['tag']), /v0\.2\.0/)
  assert.match(runGit(root, ['log', 'main', '-1', '--pretty=%s']), /release v0\.2\.0/)
})

test('повторный релиз без новых этапов ничего не выпускает', () => {
  const { db, root, config } = repoWithMergedStage()
  release(db, { root, level: 'minor', config, actor: 'owner' })
  const second = release(db, { root, level: 'minor', config, actor: 'owner' })

  assert.equal(second.released, false)
  assert.match(runGit(root, ['tag']), /v0\.2\.0/)
  assert.doesNotMatch(runGit(root, ['tag']), /v0\.3\.0/)
})

test('релиз требует чистое дерево', () => {
  const { db, root, config } = repoWithMergedStage()
  writeFileSync(join(root, 'README.md'), 'изменено')
  assert.throws(() => release(db, { root, level: 'patch', config, actor: 'owner' }), /грязн/)
})
