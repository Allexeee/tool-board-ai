import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
import { doneTask } from '../../src/core/done.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { commitTask } from '../../src/core/git/commit.ts'
import { mergeStage } from '../../src/core/git/merge.ts'
import { runGit } from '../../src/core/git/git.ts'

function conflictingStage() {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const feature = addFeature(db, { name: 'Оплата', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  const task = createTask(db, {
    stageId: stage.id,
    title: 'Правка файла',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)

  const { worktree, branch } = startFeature(db, { root, featureId: feature.id, config })
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'второй вариант\n')

  takeTask(db, { executor: 'w1', taskId: task.id })
  commitTask({ worktree, task, report: { summary: 'готово', checks: [] } })
  doneTask(db, { taskId: task.id, executor: 'w1', report: { summary: 'готово', checks: [] } })

  runGit(root, ['checkout', 'dev'])
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src/a.ts'), 'третий вариант\n')
  runGit(root, ['add', 'src/a.ts'])
  runGit(root, ['commit', '-m', 'chore: другой вариант'], { AL_ALLOW: '1' })
  runGit(root, ['checkout', 'main'])

  return { db, root, config, stage, branch }
}

test('конфликт отменяет merge и создаёт срочную задачу', () => {
  const { db, root, config, stage } = conflictingStage()
  const result = mergeStage(db, { root, stageId: stage.id, config })

  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /конфликт/)

  const task = getTask(db, result.taskId!)
  assert.equal(task.class, 'expedite')
  assert.match(task.title, /конфликт/i)
  assert.doesNotMatch(runGit(root, ['status', '--porcelain']), /^(UU|AA|DD)/m)
  assert.throws(() => runGit(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']))
})
