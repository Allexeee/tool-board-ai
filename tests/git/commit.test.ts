import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask } from '../../src/core/tasks.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { commitTask, filesOutsideScope, saveDraft } from '../../src/core/git/commit.ts'
import { runGit } from '../../src/core/git/git.ts'

function fixture() {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))
  const feature = addFeature(db, { name: 'Оплата', rank: 1 })
  const stage = addStage(db, { featureId: feature.id, name: 'S1', goal: 'g', appetite: '2 дня' })
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
  const { worktree } = startFeature(db, { root, featureId: feature.id, config })
  return { db, root, config, worktree, task }
}

test('done коммитит файлы своей области', () => {
  const { worktree, task } = fixture()
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')

  const sha = commitTask({ worktree, task, report: { summary: 'сделано', checks: [] } })
  assert.ok(sha)

  const files = runGit(worktree, ['show', '--name-only', '--pretty=', sha!]).split('\n')
  assert.deepEqual(files, ['src/a.ts'])
})

test('коммит в чужую ветку отвергается', () => {
  const { worktree, task, root, config } = fixture()
  const expected = runGit(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')

  runGit(worktree, ['checkout', config.branches.dev])
  assert.throws(
    () =>
      commitTask({
        worktree,
        task,
        report: { summary: 'сделано', checks: [] },
        expectedBranch: expected,
      }),
    /стоит на dev/,
  )
  void root
})

test('detached HEAD отвергается', () => {
  const { worktree, task } = fixture()
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  runGit(worktree, ['checkout', '--detach'])

  assert.throws(
    () => commitTask({ worktree, task, report: { summary: 'сделано', checks: [] } }),
    /detached/,
  )
})

test('запрещённая ветка отвергается', () => {
  const { worktree, task, config } = fixture()
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')

  assert.throws(
    () =>
      commitTask({
        worktree,
        task,
        report: { summary: 'сделано', checks: [] },
        forbiddenBranches: [runGit(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])],
      }),
    /защищённую ветку/,
  )
  void config
})

test('пустой diff не создаёт коммит и не падает', () => {
  const { worktree, task } = fixture()
  assert.equal(commitTask({ worktree, task, report: { summary: 's', checks: [] } }), null)
})

test('save пишет черновик', () => {
  const { worktree, task } = fixture()
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  const sha = saveDraft({ worktree, task, summary: 'половина' })
  assert.ok(sha)
  assert.match(runGit(worktree, ['log', '-1', '--pretty=%s', sha!]), /wip:/)
})

test('файл вне области не коммитится и не мешает', () => {
  const { worktree, task } = fixture()
  mkdirSync(join(worktree, 'src'), { recursive: true })
  mkdirSync(join(worktree, 'docs'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  writeFileSync(join(worktree, 'docs/b.md'), 'b')

  const sha = commitTask({ worktree, task, report: { summary: 's', checks: [] } })
  const files = runGit(worktree, ['show', '--name-only', '--pretty=', sha!]).split('\n')

  assert.deepEqual(files, ['src/a.ts'])
  assert.equal(existsSync(join(worktree, 'docs/b.md')), true)
})

test('файл с русским именем попадает в область', () => {
  const { worktree, task } = fixture()
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src', 'тест.ts'), 'a')

  const sha = commitTask({ worktree, task, report: { summary: 's', checks: [] } })
  assert.ok(sha)
})

test('scope-каталог покрывает файлы внутри', () => {
  const { worktree, task } = fixture()
  const dirTask = { ...task, scope: ['src'] as const }
  mkdirSync(join(worktree, 'src'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')

  const sha = commitTask({ worktree, task: dirTask, report: { summary: 's', checks: [] } })
  assert.ok(sha)
})

test('exclusive коммитит только разрешённые пути', () => {
  const { worktree, task } = fixture()
  mkdirSync(join(worktree, 'src'), { recursive: true })
  mkdirSync(join(worktree, 'docs'), { recursive: true })
  writeFileSync(join(worktree, 'src/a.ts'), 'a')
  writeFileSync(join(worktree, 'docs/b.md'), 'b')

  const sha = commitTask({
    worktree,
    task: { ...task, scope: 'exclusive' },
    report: { summary: 's', checks: [] },
    limitTo: ['src/a.ts'],
  })

  const files = runGit(worktree, ['show', '--name-only', '--pretty=', sha!]).split('\n')
  assert.deepEqual(files, ['src/a.ts'])
  assert.equal(existsSync(join(worktree, 'docs/b.md')), true)
})

test('файлы вне области видны отдельным списком', () => {
  const { worktree, task } = fixture()
  mkdirSync(join(worktree, 'docs'), { recursive: true })
  writeFileSync(join(worktree, 'docs/b.md'), 'b')

  assert.deepEqual(filesOutsideScope(worktree, task), ['docs/b.md'])
})


