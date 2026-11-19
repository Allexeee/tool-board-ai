import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nowIso } from './clock.ts'

/** Локальные настройки доски: файл `.board/settings.json`, не база. */
export interface BoardSettings {
  version: 1
  /** Ревью после каждого забега: по умолчанию выключено. */
  reviewAfterRun: boolean
  /** Когда мастер настроек последний раз завершался; null — ещё не запускался. */
  setupAt: string | null
}

export const DEFAULT_SETTINGS: BoardSettings = {
  version: 1,
  reviewAfterRun: false,
  setupAt: null,
}

export function settingsPath(root: string): string {
  return join(root, '.board', 'settings.json')
}

/**
 * Читает настройки. Отсутствующий или испорченный файл — это дефолт:
 * доска не должна падать из-за локального конфига.
 */
export function readSettings(root: string): BoardSettings {
  const path = settingsPath(root)
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS }

  try {
    // PowerShell и часть редакторов пишут UTF-8 BOM: для JSON это мусор.
    const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as Partial<BoardSettings>
    return {
      version: 1,
      reviewAfterRun: raw.reviewAfterRun === true,
      setupAt: typeof raw.setupAt === 'string' && raw.setupAt.trim() !== '' ? raw.setupAt : null,
    }
  } catch {
    return { ...DEFAULT_SETTINGS }
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
  const settings = { ...DEFAULT_SETTINGS }
  writeSettings(root, settings)
  return { settings, created: true }
}

/** Меняет выбранные поля и отмечает, что мастер настроек завершён. */
export function updateSettings(
  root: string,
  patch: { reviewAfterRun?: boolean },
  now: () => string = nowIso,
): BoardSettings {
  const current = readSettings(root)
  const next: BoardSettings = {
    ...current,
    reviewAfterRun: patch.reviewAfterRun ?? current.reviewAfterRun,
    setupAt: now(),
  }
  writeSettings(root, next)
  return next
}
