import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { addFeature, setFeatureCheck, getFeature } from '../../src/core/features.ts'
import { addRequest, closeKind, getRequest } from '../../src/core/requests.ts'
import { addStage, activateNextStage, getStage } from '../../src/core/stages.ts'
import { createTask, getTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
import { doneTask } from '../../src/core/done.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { commitTask } from '../../src/core/git/commit.ts'
import { mergeStage } from '../../src/core/git/merge.ts'
import { runGit } from '../../src/core/git/git.ts'

export function mergedReadyFixture(options: {
  check?: string
  skipDev?: boolean
  acceptance?: 'auto' | 'owner' | 'owner_before_next'
} = {}) {
  let root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const request = addRequest(db, { title: 'Оплата', body: '', author: 'owner' })
  const feature = addFeature(db, { requestId: request.id, name: 'Оплата', rank: 1 })
  if (options.check) setFeatureCheck(db, feature.id, options.check)
  const stage = addStage(db, {
    featureId: feature.id,
    name: 'S1',
    goal: 'g',
    appetite: '2 дня',
    acceptance: options.acceptance ?? 'auto',
  })
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
  if (options.skipDev) runGit(root, ['branch', '-D', 'dev'])
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')

  takeTask(db, { executor: 'w1', taskId: task.id })
  commitTask({ worktree, task, report: { summary: 'готово', checks: [] } })
  doneTask(db, { taskId: task.id, executor: 'w1', report: { summary: 'готово', checks: [] } })

  return { root, db, config, feature, stage, worktree }
}

test('этап сливается в dev и активирует следующий', () => {
  const { root, db, config, stage } = mergedReadyFixture()
  const result = mergeStage(db, { root, stageId: stage.id, config })

  assert.equal(result.merged, true)
  assert.equal(getStage(db, stage.id)!.status, 'merged')
  assert.match(runGit(root, ['log', 'dev', '--oneline']), new RegExp(result.commit!.slice(0, 7)))
})

test('упавшая проверка не сливает этап', () => {
  const { root, db, config, stage } = mergedReadyFixture({ check: 'git rev-parse --verify refs/heads/nope' })
  const result = mergeStage(db, { root, stageId: stage.id, config })

  assert.equal(result.merged, false)
  assert.match(result.reason ?? '', /проверка/)
  assert.equal(getStage(db, stage.id)!.status, 'active')
})

test('нет ветки dev — понятная ошибка', () => {
  const { root, db, config, stage } = mergedReadyFixture({ skipDev: true })
  assert.throws(() => mergeStage(db, { root, stageId: stage.id, config }), /ветк/)
})

test('после слияния последнего этапа запрос закрывается', () => {
  const { root, db, config, stage, feature } = mergedReadyFixture()
  mergeStage(db, { root, stageId: stage.id, config })

  const request = getRequest(db, feature.requestId!)
  assert.equal(request?.status, 'closed')
  assert.equal(closeKind(db, feature.requestId!), 'done')
})

test('запрос не закрывается, пока у него есть другая фича', () => {
  const { root, db, config, stage, feature } = mergedReadyFixture()
  addFeature(db, { requestId: feature.requestId!, name: 'Вторая', rank: 2 })

  mergeStage(db, { root, stageId: stage.id, config })

  assert.notEqual(getRequest(db, feature.requestId!)!.status, 'closed')
})

test('после слияния каталог фичи удаляется, а ветка остаётся', () => {
  const { root, db, config, stage, feature, worktree } = mergedReadyFixture()
  mergeStage(db, { root, stageId: stage.id, config })

  assert.equal(existsSync(worktree), false)
  assert.equal(getFeature(db, feature.id)!.worktree, null)
  const branch = getFeature(db, feature.id)!.branch!
  assert.ok(runGit(root, ['branch', '--list', branch]).length > 0)
})

test('грязный каталог спасается коммитом и тегом', () => {
  const { root, db, config, stage, feature, worktree } = mergedReadyFixture()
  writeFileSync(join(worktree, 'src', 'черновик.txt'), 'недоделка')

  mergeStage(db, { root, stageId: stage.id, config })

  assert.equal(existsSync(worktree), false)
  const tags = runGit(root, ['tag', '--list', 'archive/*'])
  assert.match(tags, /archive\//)
  const branch = getFeature(db, feature.id)!.branch!
  const last = runGit(root, ['log', '-1', '--pretty=%s', branch])
  assert.match(last, /остатки/)
})

test('если спасти не удалось, каталог остаётся', () => {
  const { root, db, config, stage, feature, worktree } = mergedReadyFixture()
  writeFileSync(join(worktree, 'src', 'черновик.txt'), 'недоделка')

  const gitDir = runGit(worktree, ['rev-parse', '--absolute-git-dir'])
  const lock = join(gitDir, 'index.lock')
  writeFileSync(lock, '')
  try {
    mergeStage(db, { root, stageId: stage.id, config })
  } finally {
    rmSync(lock, { force: true })
  }

  assert.equal(existsSync(worktree), true)
  assert.ok(getFeature(db, feature.id)!.worktree)
  const event = db
    .prepare("select note from events where type = 'feature.cleanup_skipped' order by id desc limit 1")
    .get() as { note: string } | undefined
  assert.ok(event)
})




