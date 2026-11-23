import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { nowIso } from './clock.ts'

export type SpecReviewSetting = 'auto' | 'none' | 'self' | 'subagent'
export type RunReviewSetting = 'auto' | 'none' | 'self' | 'subagent'

/** Локальные настройки доски: файл `.board/settings.json`, не база. */
export interface BoardSettings {
  version: 2
  reviewer: { model: string | null }
  specReview: { mode: SpecReviewSetting; maxSpecChars: number; largeSpecChars: number }
  runReview: { mode: RunReviewSetting }
  /** Имена веток; null — определить по git. */
  branches: { main: string | null; dev: string | null }
  /** Когда мастер настроек последний раз завершался; null — ещё не запускался. */
  setupAt: string | null
}

export const DEFAULT_SETTINGS: BoardSettings = {
  version: 2,
  reviewer: { model: null },
  specReview: { mode: 'auto', maxSpecChars: 1500, largeSpecChars: 6000 },
  runReview: { mode: 'none' },
  branches: { main: null, dev: null },
  setupAt: null,
}

export function settingsPath(root: string): string {
  return join(root, '.board', 'settings.json')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function setupAtValue(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() !== '' ? raw : null
}

function specModeValue(raw: unknown, fallback: SpecReviewSetting): SpecReviewSetting {
  return raw === 'auto' || raw === 'none' || raw === 'self' || raw === 'subagent' ? raw : fallback
}

function runModeValue(raw: unknown, fallback: RunReviewSetting): RunReviewSetting {
  return raw === 'auto' || raw === 'none' || raw === 'self' || raw === 'subagent' ? raw : fallback
}

function charLimitValue(raw: unknown, fallback: number): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : fallback
}

function branchValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  return /^[A-Za-z0-9._/-]+$/.test(value) ? value : null
}

/** Читает модель без варианта; невалидное значение при чтении считается пустым. */
function reviewerModelValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value === '' || !/^[^/\s#]+\/[^/\s#]+$/.test(value)) return null
  return value
}

function normalizeSettings(raw: unknown): BoardSettings {
  if (!isRecord(raw)) return structuredClone(DEFAULT_SETTINGS)

  const version = Number(raw.version)
  if (version === 1 || typeof raw.reviewAfterRun === 'boolean') {
    return {
      version: 2,
      reviewer: { model: null },
      specReview: { mode: 'auto', maxSpecChars: 1500, largeSpecChars: 6000 },
      runReview: { mode: raw.reviewAfterRun === true ? 'subagent' : 'none' },
      branches: { main: null, dev: null },
      setupAt: setupAtValue(raw.setupAt),
    }
  }

  const reviewer = isRecord(raw.reviewer) ? raw.reviewer : {}
  const spec = isRecord(raw.specReview) ? raw.specReview : {}
  const run = isRecord(raw.runReview) ? raw.runReview : {}
  const branches = isRecord(raw.branches) ? raw.branches : {}
  return {
    version: 2,
    reviewer: { model: reviewerModelValue(reviewer.model) },
    specReview: {
      mode: specModeValue(spec.mode, 'auto'),
      maxSpecChars: charLimitValue(spec.maxSpecChars, 1500),
      largeSpecChars: charLimitValue(spec.largeSpecChars, 6000),
    },
    runReview: { mode: runModeValue(run.mode, 'none') },
    branches: {
      main: branchValue(branches.main),
      dev: branchValue(branches.dev),
    },
    setupAt: setupAtValue(raw.setupAt),
  }
}

/**
 * Читает настройки. Отсутствующий или испорченный файл — это дефолт:
 * доска не должна падать из-за локального конфига.
 */
export function readSettings(root: string): BoardSettings {
  const path = settingsPath(root)
  if (!existsSync(path)) return structuredClone(DEFAULT_SETTINGS)

  try {
    // PowerShell и часть редакторов пишут UTF-8 BOM: для JSON это мусор.
    return normalizeSettings(
      JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')),
    )
  } catch {
    return structuredClone(DEFAULT_SETTINGS)
  }
}

/** Атомарная запись: temp + rename, чтобы не оставить половину файла. */
export function writeSettings(root: string, settings: BoardSettings): void {
  mkdirSync(join(root, '.board'), { recursive: true })
  const path = settingsPath(root)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  renameSync(tmp, path)
}

/** Создаёт дефолтный файл, если его нет; существующий не трогает. */
export function ensureSettings(root: string): { settings: BoardSettings; created: boolean } {
  if (existsSync(settingsPath(root))) {
    return { settings: readSettings(root), created: false }
  }
  const settings = structuredClone(DEFAULT_SETTINGS)
  writeSettings(root, settings)
  return { settings, created: true }
}

export function validateReviewerModel(raw: string | null): string | null {
  if (raw === null) return null
  const value = raw.trim()
  if (value === '') return null
  if (!/^[^/\s#]+\/[^/\s#]+$/.test(value)) {
    throw new UserError(3, 'reviewer.model — provider/model без #variant')
  }
  return value
}

function validateSpecMode(raw: string): SpecReviewSetting {
  if (raw === 'auto' || raw === 'none' || raw === 'self' || raw === 'subagent') return raw
  throw new UserError(3, 'spec-review — auto|none|self|subagent')
}

function validateRunMode(raw: string): RunReviewSetting {
  if (raw === 'auto' || raw === 'none' || raw === 'self' || raw === 'subagent') return raw
  throw new UserError(3, 'run-review — auto|none|self|subagent')
}

function validateLargeSpec(raw: number): number {
  if (!Number.isInteger(raw) || raw < 0) {
    throw new UserError(3, 'large-spec — целое число от 0')
  }
  return raw
}

function validateMaxSpec(raw: number): number {
  if (!Number.isInteger(raw) || raw < 0) {
    throw new UserError(3, 'max-spec — целое число от 0')
  }
  return raw
}

/** Пустая строка — сброс на автоопределение по git. */
function validateBranchInput(raw: string | null): string | null {
  if (raw === null) return null
  const value = raw.trim()
  if (value === '') return null
  if (!/^[A-Za-z0-9._/-]+$/.test(value)) {
    throw new UserError(3, 'имя ветки: буквы, цифры, точка, дефис, слэш, подчёркивание')
  }
  return value
}

/** Меняет выбранные поля и отмечает, что мастер настроек завершён. */
export function updateSettings(
  root: string,
  patch: {
    reviewer?: { model?: string | null }
    specReview?: { mode?: SpecReviewSetting; maxSpecChars?: number; largeSpecChars?: number }
    runReview?: { mode?: RunReviewSetting }
    branches?: { main?: string | null; dev?: string | null }
  },
  now: () => string = nowIso,
): BoardSettings {
  const current = readSettings(root)
  const next: BoardSettings = {
    version: 2,
    reviewer: {
      model:
        patch.reviewer?.model !== undefined
          ? validateReviewerModel(patch.reviewer.model)
          : current.reviewer.model,
    },
    specReview: {
      mode:
        patch.specReview?.mode !== undefined
          ? validateSpecMode(patch.specReview.mode)
          : current.specReview.mode,
      maxSpecChars:
        patch.specReview?.maxSpecChars !== undefined
          ? validateMaxSpec(patch.specReview.maxSpecChars)
          : current.specReview.maxSpecChars,
      largeSpecChars:
        patch.specReview?.largeSpecChars !== undefined
          ? validateLargeSpec(patch.specReview.largeSpecChars)
          : current.specReview.largeSpecChars,
    },
    runReview: {
      mode:
        patch.runReview?.mode !== undefined
          ? validateRunMode(patch.runReview.mode)
          : current.runReview.mode,
    },
    branches: {
      main:
        patch.branches?.main !== undefined
          ? validateBranchInput(patch.branches.main)
          : current.branches.main,
      dev:
        patch.branches?.dev !== undefined
          ? validateBranchInput(patch.branches.dev)
          : current.branches.dev,
    },
    setupAt: now(),
  }
  writeSettings(root, next)
  return next
}
