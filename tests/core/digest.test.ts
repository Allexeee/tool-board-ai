import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
import { classifyRisk, formatDigest, reviewDigest } from '../../src/core/digest.ts'

function repoWithTwoStages() {
  const root = makeRepoWithDev()
  initProject(root)
  const db = openDb(join(root, '.toolbox-al/tracker.db'))
  const config = readConfig(join(root, '.toolbox-al/config.json'))
  addExecutor(db, { id: 'w1', kind: 'agent', skills: ['backend'] })

  const feature = addFeature(db, { name: 'Оплата', rank: 1 })
  const first = addStage(db, { featureId: feature.id, name: 'Каркас', goal: 'g', appetite: '2 дня' })
  const second = addStage(db, { featureId: feature.id, name: 'Форма', goal: 'g', appetite: '2 дня' })
  activateNextStage(db, feature.id)

  const { worktree } = startFeature(db, { root, featureId: feature.id, config })

  // этап проходит полный путь: задача, коммит в ветку фичи, слияние в dev
  const seedStage = (stage: ReturnType<typeof addStage>, files: string[]): void => {
    const task = createTask(db, {
      stageId: stage.id,
      title: `Сделать ${stage.name}`,
      dod: ['готово'],
      size: 'S',
      skill: 'backend',
      class: 'standard',
      scope: files,
    })
    refreshReady(db)

    for (const file of files) {
      mkdirSync(dirname(join(worktree, file)), { recursive: true })
      writeFileSync(join(worktree, file), `${file}\n`)
    }

    takeTask(db, { executor: 'w1', taskId: task.id })
    commitTask({ worktree, task, report: { summary: 'готово', checks: [] } })
    doneTask(db, { taskId: task.id, executor: 'w1', report: { summary: 'готово', checks: [] } })
    mergeStage(db, { root, stageId: stage.id, config })
  }

  seedStage(first, ['src/core/lease.ts', 'tests/core/lease.test.ts'])
  seedStage(second, ['src/ui/form.tsx'])

  return { root, db, config, first, second }
}

test('дайджест различает нерелизнутые этапы по файлам из git', () => {
  const { db, root, config, first, second } = repoWithTwoStages()

  const stages = reviewDigest(db, { root, config })

  assert.deepEqual(
    stages.map((stage) => [stage.stageId, stage.stageName]),
    [
      [first.id, 'Каркас'],
      [second.id, 'Форма'],
    ],
  )
  assert.deepEqual(
    stages[0].files,
    [
      { path: 'src/core/lease.ts', risk: 'high' },
      { path: 'tests/core/lease.test.ts', risk: 'low' },
    ],
    'файлы первого этапа взяты из его коммита слияния',
  )
  assert.deepEqual(stages[1].files, [{ path: 'src/ui/form.tsx', risk: 'normal' }])
  assert.equal(stages[0].risk, 'high', 'риск этапа — худший из его файлов')
  assert.equal(stages[1].risk, 'normal')
})

test('риск файла: ядро и git — высокий, тесты — низкий, остальное — обычный', () => {
  assert.equal(classifyRisk('src/core/schema.ts'), 'high')
  assert.equal(classifyRisk('src/core/hands.ts'), 'high')
  assert.equal(classifyRisk('src/core/lease.ts'), 'high')
  assert.equal(classifyRisk('src/core/git/merge.ts'), 'high')
  assert.equal(classifyRisk('tests/core/lease.test.ts'), 'low')
  assert.equal(classifyRisk('src/ui/form.tsx'), 'normal')
  assert.equal(classifyRisk('src/core/digest.ts'), 'normal')
})

test('текст дайджеста помечает риск словом, а не цветом', () => {
  const { db, root, config } = repoWithTwoStages()

  const text = formatDigest(reviewDigest(db, { root, config }))

  assert.match(text, /нерелизнуто этапов: 2/)
  assert.match(text, /F1\.S1 {2}Каркас — риск: высокий/)
  assert.match(text, /F1\.S2 {2}Форма — риск: обычный/)
  assert.match(text, /высокий {2}src\/core\/lease\.ts/)
  assert.match(text, /низкий {3}tests\/core\/lease\.test\.ts/)
  assert.doesNotMatch(text, /\u001b\[/, 'цвет — украшение, в отчёте его нет')
})

test('команда review digest печатает тот же отчёт', () => {
  const { root } = repoWithTwoStages()

  const shown = spawnSync(process.execPath, [resolve('bin/toolbox-al.ts'), 'review', 'digest'], {
    cwd: root,
    encoding: 'utf8',
  })

  assert.equal(shown.status, 0, shown.stderr)
  assert.match(shown.stdout, /F1\.S1 {2}Каркас — риск: высокий/)
  assert.match(shown.stdout, /src\/ui\/form\.tsx/)
  assert.doesNotMatch(shown.stdout, /\u001b\[/)
})

test('после релиза дайджест пуст: смотреть нечего', () => {
  const { db, root, config } = repoWithTwoStages()
  release(db, { root, level: 'minor', reason: 'первый', config, actor: 'owner' })

  assert.deepEqual(reviewDigest(db, { root, config }), [])
  assert.match(formatDigest([]), /нерелизнутых этапов нет/)
})
