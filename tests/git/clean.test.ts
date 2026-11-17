import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { abandonFeature, addFeature, getFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
import { doneTask } from '../../src/core/done.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { commitTask } from '../../src/core/git/commit.ts'
import { mergeStage } from '../../src/core/git/merge.ts'
import { cleanFeature, cleanWorktree, sweepBranches } from '../../src/core/git/clean.ts'
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

function mergedFixture(commitDate?: string) {
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
    title: 'Шаг',
    dod: ['a'],
    size: 'S',
    skill: 'backend',
    class: 'standard',
    scope: ['src/**'],
  })
  refreshReady(db)

  const { worktree } = startFeature(db, { root, featureId: feature.id, config })
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', 'a.ts'), 'a')

  takeTask(db, { executor: 'w1', taskId: task.id })
  commitTask({ worktree, task, report: { summary: 'готово', checks: [] } })
  if (commitDate) {
    runGit(worktree, ['commit', '--amend', '--no-edit'], {
      GIT_AUTHOR_DATE: commitDate,
      GIT_COMMITTER_DATE: commitDate,
    })
  }
  doneTask(db, { taskId: task.id, executor: 'w1', report: { summary: 'готово', checks: [] } })

  mergeStage(db, { root, stageId: stage.id, config })

  return { root, db, config, feature, stage }
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

test('свежая слитая ветка остаётся после слияния', () => {
  const { root, db, feature } = mergedFixture()

  assert.ok(getFeature(db, feature.id)!.branch)
  assert.equal(branchExists(root, getFeature(db, feature.id)!.branch!), true)
})

test('старая слитая ветка удаляется при слиянии', () => {
  const old = new Date(Date.now() - 40 * 86_400_000).toISOString()
  const { root, db, feature } = mergedFixture(old)

  const branch = getFeature(db, feature.id)!.branch
  if (branch) assert.equal(branchExists(root, branch), false)
})

test('свежая отменённая фича ждёт выдержки', () => {
  const { root, db, config, feature, branch, worktree } = cancelledFixture()

  const result = sweepBranches(db, { root, config, actor: 'system' })

  assert.deepEqual(result.deleted, [])
  assert.ok(result.kept.includes(branch))
  assert.equal(existsSync(worktree), true)
  assert.equal(getFeature(db, feature.id)!.status, 'cancelled')
})

test('отменённая фича старше выдержки убирается с тегом archive', () => {
  const { root, db, config, feature, branch, worktree } = cancelledFixture()
  db.prepare("update events set at = ? where type = 'feature.abandoned'").run(
    new Date(Date.now() - 40 * 86_400_000).toISOString(),
  )

  const result = sweepBranches(db, { root, config, actor: 'system' })

  assert.deepEqual(result.deleted, [branch])
  assert.equal(existsSync(worktree), false)
  assert.equal(branchExists(root, branch), false)
  assert.match(runGit(root, ['tag', '--list', 'archive/*']), /archive\//)
  assert.equal(getFeature(db, feature.id)!.worktree, null)
})

test('грязный каталог отменённой фичи спасается, а не теряется', () => {
  const { root, db, config, feature, branch, worktree } = cancelledFixture()
  writeFileSync(join(worktree, 'src', 'черновик.txt'), 'недоделка')
  db.prepare("update events set at = ? where type = 'feature.abandoned'").run(
    new Date(Date.now() - 40 * 86_400_000).toISOString(),
  )

  sweepBranches(db, { root, config, actor: 'system' })

  assert.equal(existsSync(worktree), false)
  const tag = runGit(root, ['tag', '--list', 'archive/*']).split('\n')[0]
  assert.ok(tag)
  const last = runGit(root, ['log', '-1', '--pretty=%s', tag])
  assert.match(last, /остатки/)
})

test('каталог, снятый с учёта git, удаляется напрямую', () => {
  const { root, db, config, feature } = cancelledFixture()
  const plain = join(root, '.worktrees', 'f1-oplata')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'note.txt'), 'остаток')
  db.prepare('update features set worktree = ? where id = ?').run(plain, feature.id)

  const result = cleanFeature(db, { featureId: feature.id, root, branch: false, config, actor: 'owner' })

  assert.equal(result.removed, true)
  assert.equal(existsSync(plain), false)
})

test('каталог вне .worktrees не удаляется', () => {
  const { root, db, config, feature } = cancelledFixture()
  const outside = mkdtempSync(join(tmpdir(), 'al-keep-'))
  writeFileSync(join(outside, 'важное.txt'), 'не трогать')
  db.prepare('update features set worktree = ? where id = ?').run(outside, feature.id)

  const result = cleanFeature(db, { featureId: feature.id, root, branch: false, config, actor: 'owner' })

  assert.equal(result.removed, false)
  assert.match(result.reason ?? '', /вне \.worktrees/)
  assert.equal(existsSync(outside), true)
})

test('занятый каталог остаётся и объясняет, что делать', () => {
  const { root, db, feature } = cancelledFixture()
  const plain = join(root, '.worktrees', 'busy-test')
  mkdirSync(plain, { recursive: true })
  writeFileSync(join(plain, 'hold.txt'), 'x')
  db.prepare('update features set worktree = ? where id = ?').run(plain, feature.id)

  // чужой процесс держит каталог текущим: Windows не даст его удалить
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], {
    cwd: plain,
    stdio: 'ignore',
  })
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400)

  let result
  try {
    result = cleanWorktree(db, { featureId: feature.id, root, actor: 'owner' })
  } finally {
    child.kill()
  }

  assert.equal(result.removed, false)
  assert.match(result.reason ?? '', /Закройте процесс/)
  assert.equal(existsSync(plain), true)
})

test('ветка с новым коммитом после слияния не считается влитой', () => {
  const { root, db, config, feature } = mergedFixture()
  const branch = getFeature(db, feature.id)!.branch!

  const head = runGit(root, ['rev-parse', branch])
  const tree = runGit(root, ['rev-parse', `${head}^{tree}`])
  const commit = runGit(root, ['commit-tree', tree, '-p', head, '-m', 'позже'], {
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@e.x',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@e.x',
  })
  runGit(root, ['branch', '-f', branch, commit])

  const result = sweepBranches(db, {
    root,
    config: { ...config, branchRetentionDays: 0 },
    actor: 'system',
  })

  assert.deepEqual(result.deleted, [])
  assert.ok(result.kept.includes(branch))
  assert.equal(branchExists(root, branch), true)
})

test('игнорируемые файлы спасаются в архивный тег', () => {
  const { root, db, config, feature, worktree } = cancelledFixture()
  writeFileSync(join(worktree, '.gitignore'), 'local/\n')
  mkdirSync(join(worktree, 'local'), { recursive: true })
  writeFileSync(join(worktree, 'local', 'секрет.env'), 'ключ')
  runGit(worktree, ['add', '.gitignore'])
  runGit(worktree, ['commit', '-m', 'ignore'])

  cleanFeature(db, { featureId: feature.id, root, branch: false, config, actor: 'owner' })

  const tag = runGit(root, ['tag', '--list', 'archive/*']).split('\n')[0]
  const tree = runGit(root, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', tag])
  assert.match(tree, /local\/секрет\.env/)
})


