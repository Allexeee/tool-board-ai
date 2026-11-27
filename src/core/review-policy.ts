import type { BoardSettings, ReviewProfile } from './settings.ts'

export type ConcreteSpecMode = 'none' | 'self' | 'subagent'
export type ConcreteRunMode = 'none' | 'self' | 'subagent'
export type ProfileRunMode = 'auto' | 'none' | 'self' | 'subagent'

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
    | 'light-run'
    | 'heavy-run'
  reviewerModel: string | null
}

export interface ResolvedReviewProfile {
  name: string
  profile: ReviewProfile
}

/** Встроенные профили: только чтение; свои — в settings.review.profiles. */
export const BUILTIN_PROFILES: Record<'low' | 'default' | 'high' | 'max', ReviewProfile> = {
  low: {
    spec: 'self',
    specWords: 0,
    card: 'needs_merge',
    reopens: 0,
    run: 'none',
    findings: 'critical',
  },
  default: {
    spec: 'auto',
    specWords: 500,
    card: 'needs_merge',
    reopens: 1,
    run: 'auto',
    findings: 'critical',
  },
  high: {
    spec: 'auto',
    specWords: 250,
    card: 'needs_merge',
    reopens: 2,
    run: 'subagent',
    findings: 'critical+important',
  },
  max: {
    spec: 'subagent',
    specWords: 0,
    card: 'always',
    reopens: 3,
    run: 'subagent',
    findings: 'critical+important',
  },
}

export function modelContext(env: NodeJS.ProcessEnv = process.env): ModelContext {
  const variant = env.BOARD_MODEL_VARIANT?.trim().toLowerCase()
  const sessionModel = env.BOARD_SESSION_MODEL?.trim()
  return {
    variant: variant && ['low', 'default', 'high', 'max'].includes(variant) ? variant : null,
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

export function countWords(text: string): number {
  const value = text.trim()
  return value === '' ? 0 : value.split(/\s+/).length
}

function customProfile(settings: BoardSettings): ReviewProfile {
  return {
    spec: settings.specReview.mode,
    specWords: 0,
    card: 'needs_merge',
    reopens: 1,
    run: settings.runReview.mode,
    findings: 'critical',
  }
}

/** Профиль по `auto` и варианту модели; без варианта — default. */
export function resolveReviewProfile(
  settings: BoardSettings,
  context: ModelContext,
): ResolvedReviewProfile {
  const variant = context.variant?.trim().toLowerCase() ?? ''
  const key = variant === 'low' || variant === 'high' || variant === 'max' ? variant : 'default'
  const configured = settings.review.profile
  const name = configured === 'auto' ? settings.review.modelMap[key] : configured
  const profile =
    name === 'custom'
      ? customProfile(settings)
      : (BUILTIN_PROFILES[name as keyof typeof BUILTIN_PROFILES] ?? settings.review.profiles[name])
  if (!profile) return { name: 'default', profile: BUILTIN_PROFILES.default }
  return { name, profile }
}

/** Режим run review на старте: `auto` разрешается на run end по лёгкости. */
export function profileRunMode(settings: BoardSettings, context: ModelContext): ProfileRunMode {
  const { name, profile } = resolveReviewProfile(settings, context)
  if (name === 'custom') return settings.runReview.mode
  return profile.run
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
  specText?: string
  context: ModelContext
}): ReviewResolution {
  const reviewerModel = effectiveReviewerModel(input.settings, input.context)
  const { name, profile } = resolveReviewProfile(input.settings, input.context)

  // Старые отдельные настройки сохраняют пороги в символах.
  if (name === 'custom') {
    const setting = input.settings.specReview.mode
    if (setting !== 'auto') return { mode: setting, reason: 'explicit', reviewerModel }
    if (!reviewerModel) return { mode: 'self', reason: 'no-reviewer-model', reviewerModel: null }
    const maxModel = isMax(input.context.variant)
    const limit = maxModel
      ? input.settings.specReview.maxSpecChars
      : input.settings.specReview.largeSpecChars
    if (limit > 0 && input.specLength >= limit) {
      return { mode: 'subagent', reason: maxModel ? 'max-spec' : 'large-spec', reviewerModel }
    }
    return { mode: 'self', reason: 'default-self', reviewerModel }
  }

  if (profile.spec !== 'auto') {
    return { mode: profile.spec, reason: 'explicit', reviewerModel }
  }
  if (!reviewerModel) return { mode: 'self', reason: 'no-reviewer-model', reviewerModel: null }
  const words = countWords(input.specText ?? '')
  if (profile.specWords > 0 && words >= profile.specWords) {
    return { mode: 'subagent', reason: 'large-spec', reviewerModel }
  }
  return { mode: 'self', reason: 'default-self', reviewerModel }
}

/** Resolved run review mode для custom и принудительных вызовов. */
export function resolveRunReviewMode(input: {
  settings: BoardSettings
  context: ModelContext
}): ReviewResolution {
  const reviewerModel = effectiveReviewerModel(input.settings, input.context)
  const { name, profile } = resolveReviewProfile(input.settings, input.context)
  if (name === 'custom') {
    const setting = input.settings.runReview.mode
    if (setting !== 'auto') return { mode: setting, reason: 'explicit', reviewerModel }
    if (!reviewerModel) return { mode: 'self', reason: 'no-reviewer-model', reviewerModel: null }
    if (isMaxOrHigh(input.context.variant)) {
      return { mode: 'subagent', reason: 'model-max-high', reviewerModel }
    }
    return { mode: 'self', reason: 'default-self', reviewerModel }
  }
  if (profile.run !== 'auto') return { mode: profile.run, reason: 'explicit', reviewerModel }
  if (!reviewerModel) return { mode: 'self', reason: 'no-reviewer-model', reviewerModel: null }
  return { mode: 'subagent', reason: 'model-max-high', reviewerModel }
}

/** Лимит реревью для не-владельца; -1 — без лимита. */
export function reviewReopensLimit(settings: BoardSettings, context: ModelContext): number {
  return resolveReviewProfile(settings, context).profile.reopens
}

/** Какие находки чинятся сразу: critical или ещё important. */
export function findingsScope(
  settings: BoardSettings,
  context: ModelContext,
): ReviewProfile['findings'] {
  return resolveReviewProfile(settings, context).profile.findings
}

/** Пакетное ревью перед релизом требуется всегда; профиль его не отменяет. */
export function packageReviewRequired(
  _settings: BoardSettings,
  _context: ModelContext,
): boolean {
  return true
}
