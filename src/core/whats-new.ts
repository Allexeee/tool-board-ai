import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareSemver, parseSemver } from './version.ts'

/**
 * «Что нового» для человека: по файлу `docs/whats-new/<version>.md` на релиз.
 * Внутри — только пункты списка: 3–5 возможностей без флагов и CLI-жаргона.
 * Board не рендерит CHANGELOG: технические строки остаются техническими.
 */
export interface WhatsNewEntry {
  version: string
  points: string[]
}

export interface WhatsNew {
  /** Версия до обновления; null — доска только установлена. */
  from: string | null
  /** Версия после обновления; null — версия неизвестна. */
  to: string | null
  /** Релизы в диапазоне (from, to], от старого к новому. */
  whatsNew: WhatsNewEntry[]
}

/** Каталог заметок внутри пакета board: рядом с src/core. */
const MODULE_NOTES_DIR = fileURLToPath(new URL('../../docs/whats-new', import.meta.url))

/**
 * Заметки установленной версии лежат в `tools/board/docs/whats-new`; для самого
 * репозитория board — рядом с исходниками. Чужой пакет не подмешиваем: иначе
 * upgrade на старую версию показал бы заметки новой.
 */
export function whatsNewDir(root: string): string {
  const installed = join(root, 'tools', 'board', 'docs', 'whats-new')
  return existsSync(installed) ? installed : MODULE_NOTES_DIR
}

function notesPath(dir: string, version: string): string {
  return join(dir, `${version}.md`)
}

/** Пункты одного релиза: строки списка `-` или `*`. */
export function readVersionNotes(version: string, dir: string = MODULE_NOTES_DIR): string[] {
  const path = notesPath(dir, version)
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => /^\s*[-*]\s+(.+?)\s*$/.exec(line)?.[1] ?? null)
    .filter((line): line is string => line !== null && line !== '')
}

function releasedVersions(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .map((name) => /^(\d+\.\d+\.\d+)\.md$/.exec(name)?.[1] ?? null)
    .filter((version): version is string => version !== null && parseSemver(version) !== null)
    .sort(compareSemver)
}

/**
 * Релизы строго новее `from` и не новее `to`. `from = null` — все известные
 * релизы до `to` включительно; `to = null` — диапазон неизвестен, ничего не
 * показываем, чтобы не обещать будущие возможности.
 */
export function collectWhatsNew(
  from: string | null,
  to: string | null,
  dir: string = MODULE_NOTES_DIR,
): WhatsNew {
  if (to === null || parseSemver(to) === null) {
    return { from, to, whatsNew: [] }
  }

  const whatsNew = releasedVersions(dir)
    .filter((version) => from === null || compareSemver(version, from) > 0)
    .filter((version) => compareSemver(version, to) <= 0)
    .map((version) => ({ version, points: readVersionNotes(version, dir) }))
    .filter((entry) => entry.points.length > 0)

  return { from, to, whatsNew }
}

/** Текст для терминала: человеческий блок, а не строка CHANGELOG. */
export function whatsNewLines(data: WhatsNew): string[] {
  const versions = data.whatsNew
  if (versions.length === 0) return ['Что нового: изменений нет.']

  const range =
    data.from === null
      ? `v${data.to}`
      : data.from === data.to
        ? `v${data.to}`
        : `${data.from} → ${data.to}`
  const lines = [`Что нового для вас (${range}):`]
  for (const entry of versions) {
    if (versions.length > 1) lines.push('', `v${entry.version}`)
    for (const point of entry.points) lines.push(`  • ${point}`)
  }
  return lines
}

/** Файл `.board/whats-new.json`: какую версию пользователь уже видел. */
interface AnnouncedFile {
  announced?: string
}

function announcedPath(root: string): string {
  return join(root, '.board', 'whats-new.json')
}

export function readAnnouncedVersion(root: string): string | null {
  const path = announcedPath(root)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as AnnouncedFile
    const value = typeof parsed.announced === 'string' ? parsed.announced.trim() : ''
    return parseSemver(value) === null ? null : value
  } catch {
    return null
  }
}

/** Атомарно запоминает показанную версию: следующий refresh не повторяет блок. */
export function markAnnouncedVersion(root: string, version: string): void {
  if (parseSemver(version) === null) return
  const path = announcedPath(root)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify({ announced: version }, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}
