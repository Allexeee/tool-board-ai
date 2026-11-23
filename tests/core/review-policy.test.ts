import test from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveReviewerModel,
  modelContext,
  resolveRunReviewMode,
  resolveSpecReviewMode,
} from '../../src/core/review-policy.ts'
import type { BoardSettings } from '../../src/core/settings.ts'

const base: BoardSettings = {
  version: 2,
  reviewer: { model: 'opencode-go/deepseek-v4.1-flash' },
  specReview: { mode: 'auto', maxSpecChars: 1500, largeSpecChars: 6000 },
  runReview: { mode: 'none' },
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
    resolveSpecReviewMode({ settings: offMax, specLength: 6000, context: context('null') }).mode,
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
