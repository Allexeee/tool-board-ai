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
  specReview: { mode: 'auto', largeSpecChars: 6000 },
  runReview: { mode: 'none' },
  setupAt: null,
}

const context = (variant: string | null, sessionModel: string | null = null) => ({
  variant,
  sessionModel,
})

test('auto: max/high → subagent, обычный вариант → self', () => {
  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 10, context: context('max') }).mode,
    'subagent',
  )
  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 10, context: context('HIGH') }).mode,
    'subagent',
  )
  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 10, context: context('low') }).mode,
    'self',
  )
  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 10, context: context(null) }).mode,
    'self',
  )
})

test('auto: большой spec → subagent, 0 отключает правило', () => {
  assert.equal(
    resolveSpecReviewMode({ settings: base, specLength: 6000, context: context(null) }).mode,
    'subagent',
  )
  const off = { ...base, specReview: { mode: 'auto' as const, largeSpecChars: 0 } }
  assert.equal(
    resolveSpecReviewMode({ settings: off, specLength: 99_999, context: context(null) }).mode,
    'self',
  )
})

test('explicit modes ignore model and size', () => {
  for (const mode of ['none', 'self', 'subagent'] as const) {
    const settings = { ...base, specReview: { mode, largeSpecChars: 1 } }
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
    settings: { ...noModel, specReview: { mode: 'subagent', largeSpecChars: 6000 } },
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
