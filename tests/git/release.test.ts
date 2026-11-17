import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { makeRepoWithDev } from '../helpers/repo.ts'
import { initProject } from '../../src/core/project.ts'
import { openDb } from '../../src/core/db.ts'
import { readConfig } from '../../src/core/config.ts'
import { addFeature } from '../../src/core/features.ts'
import { addStage, activateNextStage } from '../../src/core/stages.ts'
import { createTask, deferTask, getTask } from '../../src/core/tasks.ts'
import { refreshReady } from '../../src/core/deps.ts'
import { addExecutor } from '../../src/core/executors.ts'
import { takeTask } from '../../src/core/lease.ts'
import { doneTask } from '../../src/core/done.ts'
import { startFeature } from '../../src/core/git/worktree.ts'
import { commitTask } from '../../src/core/git/commit.ts'
import { mergeStage } from '../../src/core/git/merge.ts'
import {
  assertReleasePreflight,
  deferredInRelease,
  pendingRelease,
  release,
  suggestLevel,
} from '../../src/core/git/release.ts'
import { runGit } from '../../src/core/git/git.ts'
import { endRun, reviewRun, startRun } from '../../src/core/runs.ts'
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

/** Этап, где одна задача закрыта, а вторая отложена: релиз не должен её брать, но обязан показать. */
function repoWithDeferredTask() {
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
  const debt = createTask(db, {
    stageId: stage.id,
    title: 'Доделать отчёт',
    dod: ['b'],
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
  deferTask(db, { id: debt.id, actor: 'owner', reason: 'ждём решения владельца по отчёту' })
  mergeStage(db, { root, stageId: stage.id, config })

  return { db, root, config, stage, debt }
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

test('pending показывает слитые этапы до релиза', () => {
  const { db } = repoWithMergedStage()

  const pending = pendingRelease(db)
  assert.equal(pending.length, 1)
  assert.equal(pending[0].stageName, 'Каркас')
  assert.equal(pending[0].featureName, 'Оплата')
})

test('pending пуст после релиза', () => {
  const { db, root, config } = repoWithMergedStage()
  release(db, { root, level: 'minor', config, actor: 'owner' })

  assert.deepEqual(pendingRelease(db), [])
})

test('pending на свежем проекте пуст', () => {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))

  assert.deepEqual(pendingRelease(db), [])
})

test('suggestLevel предлагает minor, когда есть новая возможность', () => {
  const { db, root } = repoWithMergedStage()

  const suggestion = suggestLevel(db, root)!
  assert.equal(suggestion.level, 'minor')
  assert.equal(suggestion.features, 1)
  assert.equal(suggestion.tasks, 1)
})

test('suggestLevel предлагает patch, когда закрыты только дефекты', () => {
  const { db, root } = repoWithMergedStage()
  db.prepare("update tasks set kind = 'defect', severity = 'S2'").run()

  const suggestion = suggestLevel(db, root)!
  assert.equal(suggestion.level, 'patch')
  assert.equal(suggestion.features, 0)
  assert.equal(suggestion.fixes, 1)
})

test('suggestLevel молчит, когда релизить нечего', () => {
  const { db, root, config } = repoWithMergedStage()
  release(db, { root, level: 'minor', config, actor: 'owner' })

  assert.equal(suggestLevel(db, root), null)
})

test('причина уровня попадает в changelog и событие', () => {
  const { db, root, config } = repoWithMergedStage()

  const result = release(db, {
    root,
    level: 'minor',
    reason: 'новые команды',
    config,
    actor: 'owner',
  })

  assert.match(result.changelog ?? '', /новые команды/)
  const event = db
    .prepare("select after from events where type = 'release.created' order by id desc limit 1")
    .get() as { after: string }
  const after = JSON.parse(event.after) as { level: string; reason: string }
  assert.equal(after.level, 'minor')
  assert.equal(after.reason, 'новые команды')
})

test('существующий тег v1.0.2 задаёт базу релиза', () => {
  const { db, root } = repoWithMergedStage()
  runGit(root, ['tag', 'v1.0.2'])

  const suggestion = suggestLevel(db, root)!
  assert.equal(suggestion.version, '1.0.2')

  const result = release(db, { root, level: 'minor', reason: 'новое', config: readConfig(join(root, '.toolbox-al/config.json')), actor: 'owner' })
  assert.equal(result.version, '1.1.0')
  assert.equal(result.tag, 'v1.1.0')
})

test('без тегов база остаётся 0.1.0', () => {
  const { db, root } = repoWithMergedStage()

  assert.equal(suggestLevel(db, root)!.version, '0.1.0')
})

test('preflight отвергает существующий тег и раздел changelog', () => {
  const { root } = repoWithMergedStage()
  runGit(root, ['tag', 'v1.0.2'])
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## v1.1.0 — 2026-01-01\n')

  assert.throws(() => assertReleasePreflight(root, 'v1.0.2'), /уже есть/)
  assert.throws(() => assertReleasePreflight(root, 'v1.1.0'), /CHANGELOG/)
})

test('этап, записанный в релиз, больше не попадает в pending', () => {
  const { db, root } = repoWithMergedStage()
  const [pending] = pendingRelease(db)
  release(db, { root, level: 'minor', reason: 'первый', config: readConfig(join(root, '.toolbox-al/config.json')), actor: 'owner' })

  assert.deepEqual(pendingRelease(db), [])
  void pending
})







test('dry-run показывает отложенные задачи и их причины', () => {
  const { db, root, debt } = repoWithDeferredTask()

  const waiting = deferredInRelease(db)
  assert.deepEqual(waiting.map((task) => task.id), [debt.id])
  assert.equal(waiting[0].stageId, 'F1.S1')
  assert.match(waiting[0].reason ?? '', /ждём решения владельца/)

  // блок dry-run — текст CLI; отдельного CLI-теста релиза в области нет, поэтому проверяем здесь
  const shown = spawnSync(process.execPath, [resolve('bin/toolbox-al.ts'), 'release', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(shown.status, 0, shown.stderr)
  assert.match(shown.stdout, /НЕ ВОШЛО, ЖДЁТ РЕШЕНИЯ/)
  assert.match(shown.stdout, /F1\.S1-2/)
  assert.match(shown.stdout, /ждём решения владельца/)
})

test('отложенная задача не входит в релиз, но остаётся долгом', () => {
  const { db, root, config, debt } = repoWithDeferredTask()

  const suggestion = suggestLevel(db, root)!
  assert.equal(suggestion.tasks, 1, 'отложенная не считается задачей релиза')
  assert.equal(suggestion.features, 1)

  const result = release(db, { root, level: 'minor', reason: 'новое', config, actor: 'owner' })
  assert.equal(result.released, true)
  assert.doesNotMatch(result.changelog ?? '', /F1\.S1-2/, 'в changelog только этапы, не отложенные задачи')
  assert.doesNotMatch(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), /Доделать отчёт/)

  assert.equal(getTask(db, debt.id)!.status, 'deferred', 'задача осталась отложенной')
  assert.deepEqual(
    deferredInRelease(db).map((task) => task.id),
    [debt.id],
    'долг не пропадает из отчёта и после релиза',
  )
})

test('выбор ревью попадает в changelog и событие', () => {
  const { db, root } = repoWithMergedStage()
  const config = readConfig(join(root, '.toolbox-al/config.json'))

  const result = release(db, { root, level: 'minor', reason: 'новое', review: 'fresh', config, actor: 'owner' })

  assert.match(result.changelog ?? '', /ревью: fresh/)
  const event = db
    .prepare("select after from events where type = 'release.created' order by id desc limit 1")
    .get() as { after: string }
  assert.equal((JSON.parse(event.after) as { review: string }).review, 'fresh')
})

test('релиз бампает версию в package.json проекта', () => {
  const { db, root, config } = repoWithMergedStage()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', version: '0.1.0' }), 'utf8')
  runGit(root, ['add', 'package.json'])
  runGit(root, ['commit', '-m', 'pkg'], { AL_ALLOW: '1' })

  const result = release(db, { root, level: 'minor', reason: 'новое', config, actor: 'owner' })

  assert.equal(result.version, '0.2.0')
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string; name: string }
  assert.equal(pkg.version, '0.2.0')
  assert.equal(pkg.name, 'app')
})

test('версии в releases сравниваются численно, а не по алфавиту', () => {
  const { db, root, config } = repoWithMergedStage()
  const insert = db.prepare('insert into releases (version, tag, changelog, at) values (?, ?, ?, ?)')
  insert.run('0.9.0', 'v0.9.0', '', '2026-01-01T00:00:00.000Z')
  insert.run('0.10.0', 'v0.10.0', '', '2026-01-02T00:00:00.000Z')

  assert.equal(suggestLevel(db, root)!.version, '0.10.0')

  const result = release(db, { root, level: 'minor', config, actor: 'owner' })
  assert.equal(result.version, '0.11.0')
  assert.equal(result.tag, 'v0.11.0')
})

test('новая секция changelog встаёт после заголовка и в формате проекта', () => {
  const { db, root, config } = repoWithMergedStage()
  writeFileSync(join(root, 'CHANGELOG.md'), '# Changelog\n\n## v0.1.0 - 01.01.2026\n\n- старое\n')
  runGit(root, ['add', 'CHANGELOG.md'])
  runGit(root, ['commit', '-m', 'changelog'], { AL_ALLOW: '1' })

  release(db, { root, level: 'minor', reason: 'новое', config, actor: 'owner' })

  const text = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
  const lines = text.split(/\r?\n/)
  assert.equal(lines[0], '# Changelog')
  assert.match(lines[2], /^## v0\.2\.0 — \d{2}\.\d{2}\.\d{4}$/)
  assert.ok(text.indexOf('## v0.2.0') < text.indexOf('## v0.1.0'), 'свежая секция должна быть выше старой')
  assert.match(text, /- старое/)
})

test('release предупреждает, что ревью прогона не было', () => {
  const { db, root } = repoWithMergedStage()

  const run = startRun(db, { mode: 'plan' })
  endRun(db, { id: run.id, reason: 'tasks' })

  const dry = spawnSync(process.execPath, [resolve('bin/toolbox-al.ts'), 'release', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /РЕВЬЮ ПРОГОНА:/)
  assert.match(dry.stdout, /ревью не было: 1 этап не проверялся, предлагаю run review RUN1/)

  // после пройденного ревью предупреждения нет: релиз снова чист
  reviewRun(db, { id: run.id, verdict: 'ok', actor: 'reviewer' })
  const after = spawnSync(process.execPath, [resolve('bin/toolbox-al.ts'), 'release', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(after.status, 0, after.stderr)
  assert.doesNotMatch(after.stdout, /ревью не было/)
  assert.doesNotMatch(after.stdout, /run review/)
})

test('ревью с находками тоже оставляет предупреждение у релиза', () => {
  const { db, root } = repoWithMergedStage()

  const run = startRun(db, { mode: 'plan' })
  endRun(db, { id: run.id, reason: 'decision' })
  reviewRun(db, { id: run.id, verdict: 'found', note: 'плавающий тест', actor: 'reviewer' })

  const dry = spawnSync(process.execPath, [resolve('bin/toolbox-al.ts'), 'release', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /ревью прогона RUN1 нашло замечания/)
  assert.match(dry.stdout, /предлагаю повторить run review RUN1/)
})

test('настоящий релиз предупреждает о ревью, но не отменяется', () => {
  const { db, root } = repoWithMergedStage()

  const run = startRun(db, { mode: 'plan' })
  endRun(db, { id: run.id, reason: 'tasks' })

  const released = spawnSync(
    process.execPath,
    [resolve('bin/toolbox-al.ts'), 'release', 'minor', '--reason', 'прогон закончен', '--review', 'none'],
    { cwd: root, encoding: 'utf8' },
  )

  assert.equal(released.status, 0, released.stderr)
  assert.match(released.stdout, /v0\.2\.0/)
  assert.match(released.stderr, /ревью не было: 1 этап не проверялся, предлагаю run review RUN1/)
  assert.match(runGit(root, ['tag']), /v0\.2\.0/, 'предупреждение не отменило релиз')
})

test('релиз без закрытого прогона о ревью молчит', () => {
  const { root } = repoWithMergedStage()

  const dry = spawnSync(process.execPath, [resolve('bin/toolbox-al.ts'), 'release', '--dry-run'], {
    cwd: root,
    encoding: 'utf8',
  })
  assert.equal(dry.status, 0, dry.stderr)
  assert.doesNotMatch(dry.stdout, /РЕВЬЮ ПРОГОНА/)
})

test('запись релиза в базу откатывается целиком, если не легла в releases', () => {
  const { db, root, config } = repoWithMergedStage()
  db.exec("create trigger reject_release before insert on releases begin select raise(abort, 'нет места'); end")

  assert.throws(() => release(db, { root, level: 'minor', config, actor: 'owner' }), /нет места/)

  const meta = db.prepare("select value from meta where key = 'version'").get()
  assert.equal(meta, undefined)
  const releases = db.prepare('select count(*) as n from releases').get() as { n: number }
  assert.equal(releases.n, 0)
  const events = db.prepare("select count(*) as n from events where type = 'release.created'").get() as { n: number }
  assert.equal(events.n, 0)
})
