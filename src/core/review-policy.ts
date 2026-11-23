import type { BoardSettings } from './settings.ts'

export type ConcreteSpecMode = 'none' | 'self' | 'subagent'
export type ConcreteRunMode = 'none' | 'self' | 'subagent'

export interface ModelContext {
  variant: string | null
  sessionModel: string | null
}

export interface ReviewResolution {
  mode: ConcreteSpecMode | ConcreteRunMode
  reason:
    | 'explicit'
    | 'model-max-high'
    | 'max-spec'
    | 'large-spec'
    | 'default-self'
    | 'no-reviewer-model'
  reviewerModel: string | null
}

export function modelContext(env: NodeJS.ProcessEnv = process.env): ModelContext {
  const variant = env.BOARD_MODEL_VARIANT?.trim()
  const sessionModel = env.BOARD_SESSION_MODEL?.trim()
  return {
    variant: variant ? variant : null,
    sessionModel: sessionModel ? sessionModel : null,
  }
}

function withoutVariant(model: string | null): string | null {
  if (!model) return null
  const value = model.split('#')[0]?.trim()
  return value ? value : null
}

/** Модель ревьюера: явная настройка важнее модели текущей сессии. */
export function effectiveReviewerModel(
  settings: BoardSettings,
  context: ModelContext,
): string | null {
  return withoutVariant(settings.reviewer.model ?? context.sessionModel)
}

function isMaxOrHigh(variant: string | null): boolean {
  const value = variant?.trim().toLowerCase()
  return value === 'max' || value === 'high'
}

function isMax(variant: string | null): boolean {
  return variant?.trim().toLowerCase() === 'max'
}

/** Resolved spec review mode; explicit mode never silently changes. */
export function resolveSpecReviewMode(input: {
  settings: BoardSettings
  specLength: number
  context: ModelContext
}): ReviewResolution {
  const reviewerModel = effectiveReviewerModel(input.settings, input.context)
  const setting = input.settings.specReview.mode

  if (setting !== 'auto') {
    return { mode: setting, reason: 'explicit', reviewerModel }
  }
  if (!reviewerModel) {
    return { mode: 'self', reason: 'no-reviewer-model', reviewerModel: null }
  }
  // max — отдельный, более низкий порог; high живёт по общему порогу.
  const maxModel = isMax(input.context.variant)
  const limit = maxModel
    ? input.settings.specReview.maxSpecChars
    : input.settings.specReview.largeSpecChars
  if (limit > 0 && input.specLength >= limit) {
    return { mode: 'subagent', reason: maxModel ? 'max-spec' : 'large-spec', reviewerModel }
  }
  return { mode: 'self', reason: 'default-self', reviewerModel }
}

/** Resolved run review mode; explicit mode never silently changes. */
export function resolveRunReviewMode(input: {
  settings: BoardSettings
  context: ModelContext
}): ReviewResolution {
  const reviewerModel = effectiveReviewerModel(input.settings, input.context)
  const setting = input.settings.runReview.mode
  if (setting !== 'auto') {
    return { mode: setting, reason: 'explicit', reviewerModel }
  }
  if (!reviewerModel) {
    return { mode: 'self', reason: 'no-reviewer-model', reviewerModel: null }
  }
  if (isMaxOrHigh(input.context.variant)) {
    return { mode: 'subagent', reason: 'model-max-high', reviewerModel }
  }
  return { mode: 'self', reason: 'default-self', reviewerModel }
}
