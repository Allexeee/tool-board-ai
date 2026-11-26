import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countWords,
  effectiveReviewerModel,
  findingsScope,
  modelContext,
  packageReviewRequired,
  resolveReviewProfile,
  resolveRunReviewMode,
  resolveSpecReviewMode,
} from '../../src/core/review-policy.ts'
import type { BoardSettings } from '../../src/core/settings.ts'
import { isLightRun } from '../../src/core/runs.ts'
import { makeBoard, seedCard, seedRun } from '../helpers/board.ts'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDb } from '../../src/core/db.ts'
import { mergeToDev, runGit, startCardBranch } from '../../src/core/git.ts'
import { initProject } from '../../src/core/project.ts'
import { commitGenerated, makeRepo } from '../helpers/repo.ts'

const base: BoardSettings = {
  version: 2,
  reviewer: { model: 'opencode-go/deepseek-v4.1-flash' },
  specReview: { mode: 'auto', maxSpecChars: 1500, largeSpecChars: 6000 },
  runReview: { mode: 'none' },
  review: {
    profile: 'custom',
    modelMap: { low: 'low', default: 'default', high: 'high', max: 'max' },
    profiles: {},
  },
  branches: { main: null, dev: null },
  git: true,
  sync: { remote: null },
  backlog: { path: 'docs/board/BACKLOG.md', auto: true, refreshSeconds: 5 },
  setupAt: null,
}

const context = (variant: string | null, sessionModel: string | null = null) => ({
  variant,
  sessionModel,
})

test('auto: max режется по maxSpecChars, high и остальные — по общему порогу', () => {
  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 1499, context: context('max') }).mode,
    'self',
  )
  const maxHit = resolveSpecReviewMode({ settings: base, specLength: 1500, context: context('max') })
  assert.equal(maxHit.mode, 'subagent')
  assert.equal(maxHit.reason, 'max-spec')

  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 1499, context: context('HIGH') }).mode,
    'self',
  )
  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 5999, context: context('high') }).mode,
    'self',
  )
  const highHit = resolveSpecReviewMode({ settings: base, specLength: 6000, context: context('high') })
  assert.equal(highHit.mode, 'subagent')
  assert.equal(highHit.reason, 'large-spec')

  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 10, context: context('low') }).mode,
    'self',
  )
  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 10, context: context(null) }).mode,
    'self',
  )
})

test('auto: 0 отключает порог своего уровня', () => {
  const offLarge = {
    ...base,
    specReview: { mode: 'auto' as const, maxSpecChars: 1500, largeSpecChars: 0 },
  }
  assert.equal(
    resolveSpecReviewMode({ settings: offLarge, specLength: 99_999, context: context('high') }).mode,
    'self',
  )
  assert.equal(
    resolveSpecReviewMode({ settings: offLarge, specLength: 1500, context: context('max') }).mode,
    'subagent',
  )

  const offMax = {
    ...base,
    specReview: { mode: 'auto' as const, maxSpecChars: 0, largeSpecChars: 6000 },
  }
  assert.equal(
    resolveSpecReviewMode({ settings: offMax, specLength: 99_999, context: context('max') }).mode,
    'self',
  )
  assert.equal(
    resolveSpecReviewMode({ settings: offMax, specLength: 6000, context: context(null) }).mode,
    'subagent',
  )
})

test('explicit modes ignore model and size', () => {
  for (const mode of ['none', 'self', 'subagent'] as const) {
    const settings = { ...base, specReview: { mode, maxSpecChars: 1, largeSpecChars: 1 } }
    const result = resolveSpecReviewMode({
      settings,
      specLength: 999_999,
      context: context('max'),
    })
    assert.equal(result.mode, mode)
    assert.equal(result.reason, 'explicit')
  }
})

test('subagent без модели: явный режим возвращает null, auto падает в self', () => {
  const noModel = { ...base, reviewer: { model: null } }
  const explicit = resolveSpecReviewMode({
    settings: {
      ...noModel,
      specReview: { mode: 'subagent', maxSpecChars: 1500, largeSpecChars: 6000 },
    },
    specLength: 10,
    context: context('max'),
  })
  assert.equal(explicit.mode, 'subagent')
  assert.equal(explicit.reviewerModel, null)

  const auto = resolveSpecReviewMode({
    settings: noModel,
    specLength: 10,
    context: context('max'),
  })
  assert.equal(auto.mode, 'self')
  assert.equal(auto.reason, 'no-reviewer-model')
})

test('effectiveReviewerModel: настройка важнее сессии, вариант срезается', () => {
  assert.equal(
    effectiveReviewerModel(base, context('max', 'acme/other#high')),
    'opencode-go/deepseek-v4.1-flash',
  )
  assert.equal(
    effectiveReviewerModel({ ...base, reviewer: { model: null } }, context('max', 'acme/other#high')),
    'acme/other',
  )
})

test('modelContext читает env и нормализует пустые значения', () => {
  assert.deepEqual(modelContext({ BOARD_MODEL_VARIANT: 'max', BOARD_SESSION_MODEL: 'acme/other' }), {
    variant: 'max',
    sessionModel: 'acme/other',
  })
  assert.deepEqual(modelContext({}), { variant: null, sessionModel: null })
})

test('run review: none по умолчанию, auto учитывает модель', () => {
  assert.equal(
    resolveRunReviewMode({ settings: base, context: context('max') }).mode,
    'none',
  )

  const auto = { ...base, runReview: { mode: 'auto' as const } }
  assert.equal(
    resolveRunReviewMode({ settings: auto, context: context('max') }).mode,
    'subagent',
  )
  assert.equal(
    resolveRunReviewMode({ settings: auto, context: context('high') }).mode,
    'subagent',
  )
  assert.equal(
    resolveRunReviewMode({ settings: auto, context: context('low') }).mode,
    'self',
  )

  const noModel = { ...auto, reviewer: { model: null } }
  const fallback = resolveRunReviewMode({ settings: noModel, context: context('max') })
  assert.equal(fallback.mode, 'self')
  assert.equal(fallback.reason, 'no-reviewer-model')

  const explicit = { ...base, runReview: { mode: 'subagent' as const } }
  assert.equal(
    resolveRunReviewMode({ settings: explicit, context: context('max') }).mode,
    'subagent',
  )
})

test('профили auto по варианту модели', () => {
  const settings = { ...base, review: { ...base.review, profile: 'auto' as const } }
  const at = (variant: string | null) =>
    resolveReviewProfile(settings, context(variant)).name

  assert.equal(at('low'), 'low')
  assert.equal(at('high'), 'high')
  assert.equal(at('max'), 'max')
  assert.equal(at(null), 'default')
  assert.equal(at('default'), 'default')
})

test('spec auto: default 350 слов, high 150', () => {
  const words = (count: number) => Array.from({ length: count }, () => 'слово').join(' ')
  const settings = { ...base, review: { ...base.review, profile: 'default' as const } }

  const exact = words(350)
  assert.equal(countWords(exact), 350)
  assert.equal(
    resolveSpecReviewMode({ settings, specLength: exact.length, specText: exact, context: context(null) })
      .mode,
    'subagent',
  )
  const below = words(349)
  assert.equal(
    resolveSpecReviewMode({ settings, specLength: below.length, specText: below, context: context(null) })
      .mode,
    'self',
  )

  const high = { ...settings, review: { ...settings.review, profile: 'high' as const } }
  const highExact = words(150)
  assert.equal(
    resolveSpecReviewMode({
      settings: high,
      specLength: highExact.length,
      specText: highExact,
      context: context('high'),
    }).mode,
    'subagent',
  )
})

test('findings: high/max блокируют important, default — только critical', () => {
  const withProfile = (profile: string) => ({ ...base, review: { ...base.review, profile } })
  assert.equal(findingsScope(withProfile('default'), context(null)), 'critical')
  assert.equal(findingsScope(withProfile('high'), context(null)), 'critical+important')
  assert.equal(findingsScope(withProfile('max'), context(null)), 'critical+important')
})

test('isLightRun: больше двух карточек — тяжёлый, две без merge — лёгкий', (t) => {
  const fixture = makeBoard()
  t.after(fixture.close)
  const cards = [1, 2, 3].map(() =>
    seedCard(fixture.db, { phase: 'task', status: 'ready', needsMerge: false }),
  )
  const heavy = seedRun(fixture.db, { cardIds: cards.map((card) => card.id) })
  assert.equal(isLightRun(fixture.db, heavy), false)

  const second = makeBoard()
  t.after(second.close)
  const lightCards = [1, 2].map(() =>
    seedCard(second.db, { phase: 'task', status: 'ready', needsMerge: false }),
  )
  const light = seedRun(second.db, { cardIds: lightCards.map((card) => card.id) })
  assert.equal(isLightRun(second.db, light), true)
})

test('isLightRun: dropped-карточка не утяжеляет забег', (t) => {
  const board = makeBoard()
  t.after(board.close)
  const cards = [1, 2, 3].map(() =>
    seedCard(board.db, { phase: 'task', status: 'ready', needsMerge: false }),
  )
  const run = seedRun(board.db, { cardIds: cards.map((card) => card.id) })
  board.db
    .prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?")
    .run(run.id, cards[0].id)

  assert.equal(isLightRun(board.db, run), true)
})

test('isLightRun: опасный путь в diff — тяжёлый', (t) => {
  const repo = makeRepo()
  initProject(repo.root)
  commitGenerated(repo.root)
  const db = openDb(join(repo.root, '.board', 'board.db'))
  t.after(() => {
    db.close()
    repo.close()
  })

  const card = seedCard(db, { phase: 'task', status: 'booked', skill: 'dev', scope: ['src/**'] })
  const { branch, worktree } = startCardBranch(repo.root, 'dev-a', card)
  mkdirSync(join(worktree, 'src', 'cli'), { recursive: true })
  writeFileSync(join(worktree, 'src', 'cli', 'x.ts'), 'x\n')
  runGit(worktree, ['add', '.'])
  runGit(worktree, ['commit', '-m', card.id])
  const merge = mergeToDev(repo.root, branch, card.id)
  db.prepare('update cards set merge_commit = ?, in_dev = 1 where id = ?').run(merge, card.id)

  const run = seedRun(db, { cardIds: [card.id] })
  assert.equal(isLightRun(db, run, repo.root), false)
})

test('пакет ревью обязателен везде, кроме low', () => {
  const low = { ...base, review: { ...base.review, profile: 'low' } }
  const high = { ...base, review: { ...base.review, profile: 'high' } }
  assert.equal(packageReviewRequired(low, context(null)), false)
  assert.equal(packageReviewRequired(high, context(null)), true)
})
