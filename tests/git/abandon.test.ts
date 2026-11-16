import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { addFeature, abandonFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage, listStages } from '../../src/core/stages.ts'
import { createTask, listTasks } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { runGit } from '../../src/core/git/git.ts'
import { doctorReport } from '../../src/core/doctor.ts'

function startedFeature() {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))
  const feature = addFeature(db, { name: 'Оплата', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)
  createTask(db, {
    stageId: stage.id,
    title: 'Добавить вебхук',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)
  startFeature(db, { root, featureId: feature.id, config })
  return { root, db, config, feature, stage }
}

test('abandon закрывает задачи и не сливает ветку', () => {
  const { root, db, feature } = startedFeature()
  const result = abandonFeature(db, { featureId: feature.id, actor: 'owner', reason: 'передумали' })

  assert.equal(result.status, 'cancelled')
  assert.equal(listTasks(db).every((task) => task.status === 'cancelled'), true)
  assert.equal(listStages(db, feature.id).every((stage) => stage.status === 'abandoned'), true)
  assert.match(runGit(root, ['branch', '--list', 'feat/*']), /feat\//)
})

test('doctor замечает отсутствие хука и ветки dev', () => {
  const { root, db } = startedFeature()
  runGit(root, ['branch', '-D', 'dev'])

  const report = doctorReport(db, { root, devBranch: 'dev' })
  assert.ok(report.checks.some((check) => check.name === 'git-хук' && !check.ok))
  assert.ok(report.checks.some((check) => check.name === 'ветка dev' && !check.ok))
})
