import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'
import { SCHEMA_VERSION, migrate } from './schema.ts'
import { refreshOpenCode } from './opencode.ts'
import { UserError } from '../cli/errors.ts'

const here = dirname(fileURLToPath(import.meta.url))
export const toolRoot = join(here, '..', '..')

export function toolVersion(root = toolRoot): string {
  const path = join(root, 'package.json')
  if (!existsSync(path)) return '0.0.0'

  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  const pkg = JSON.parse(raw) as { version?: string }
  return pkg.version ?? '0.0.0'
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("select value from meta where key = 'schemaVersion'").get() as
    | { value: string }
    | undefined
  return Number(row?.value ?? 0)
}

export function pinnedVersion(db: DatabaseSync): string | null {
  const row = db.prepare("select value from meta where key = 'toolVersion'").get() as
    | { value: string }
    | undefined
  return row?.value ?? null
}

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)

  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function availableVersions(root = toolRoot): string[] {
  try {
    const out = execFileSync('git', ['-C', root, 'tag', '--list', 'v*'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })

    return out
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((tag) => tag.replace(/^v/, ''))
      .sort(compare)
      .reverse()
  } catch {
    return []
  }
}

export function versionsFromDirectory(dir: string): string[] {
  const manifestPath = join(dir, 'manifest.json')
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as {
        versions?: string[]
      }
      if (Array.isArray(manifest.versions)) {
        return manifest.versions.map(String).sort(compare).reverse()
      }
    } catch {
      // битый манифест — считаем, что версий нет
    }
  }

  const packagePath = join(dir, 'package.json')
  if (existsSync(packagePath)) {
    try {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8').replace(/^\uFEFF/, '')) as {
        version?: string
      }
      if (pkg.version) return [pkg.version]
    } catch {
      return []
    }
  }

  return []
}

export interface VersionCheck {
  current: string
  available: string[]
  source: 'git' | 'dir' | 'none'
  latest: string | null
}

export function checkVersions(root: string, options: { from?: string } = {}): VersionCheck {
  const current = toolVersion(root)

  if (options.from) {
    const available = versionsFromDirectory(options.from)
    return { current, available, source: available.length ? 'dir' : 'none', latest: available[0] ?? null }
  }

  const available = availableVersions(root)
  return { current, available, source: available.length ? 'git' : 'none', latest: available[0] ?? null }
}

export interface JournalEntry {
  from: string
  to: string
  schemaFrom: number
  schemaTo: number
  backup: string
  files: string[]
  now?: Date
}

export function writeUpgradeJournal(root: string, entry: JournalEntry): string {
  const stamp = (entry.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const dir = join(root, '.toolbox-al', 'upgrades')
  mkdirSync(dir, { recursive: true })

  const path = join(dir, `${stamp}.md`)
  const lines = [
    `# Обновление ${stamp}`,
    '',
    `версия: ${entry.from} → ${entry.to}`,
    `схема: ${entry.schemaFrom} → ${entry.schemaTo}`,
    `копия базы: \`${entry.backup}\``,
    '',
    '## Обновлённые файлы',
    '',
    ...entry.files.map((file) => `- ${file}`),
    '',
    '## Откат',
    '',
    '1. Остановить работу и скопировать базу из резервной копии.',
    '2. Выполнить `git checkout` на предыдущий тег проекта.',
    '3. Запустить `toolbox-al doctor` и проверить, что схема совпадает.',
    '',
  ]

  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

export interface UpgradePlan {
  current: VersionCheck
  pinned: string
  schemaFrom: number
  schemaTo: number
  outdated: boolean
}

function readPinned(configPath?: string): string | null {
  if (!configPath || !existsSync(configPath)) return null
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')) as {
      toolVersion?: string
    }
    return config.toolVersion ?? null
  } catch {
    return null
  }
}

export function planUpgrade(
  db: DatabaseSync,
  options: { toolRoot?: string; configPath?: string; from?: string },
): UpgradePlan {
  const row = db.prepare("select value from meta where key = 'schemaVersion'").get() as
    | { value: string }
    | undefined
  const schemaFrom = Number(row?.value ?? 0)

  if (schemaFrom > SCHEMA_VERSION) {
    throw new UserError(
      3,
      `схема ${schemaFrom} новее, чем понимает инструмент (${SCHEMA_VERSION}): обновите сам инструмент`,
    )
  }

  const current = checkVersions(options.toolRoot ?? toolRoot, { from: options.from })
  const pinned = readPinned(options.configPath) ?? current.current
  const latest = current.latest ?? current.current
  const versionBehind = compare(pinned, latest) < 0

  return {
    current,
    pinned,
    schemaFrom,
    schemaTo: SCHEMA_VERSION,
    outdated: schemaFrom < SCHEMA_VERSION || versionBehind,
  }
}

export interface UpgradeResult {
  applied: boolean
  backup?: string
  plan: UpgradePlan
}

export function applyUpgrade(
  db: DatabaseSync,
  input: {
    dbPath: string
    configPath: string
    projectRoot: string
    toolRoot?: string
    from?: string
    yes: boolean
    now?: Date
  },
): UpgradeResult {
  const projectRoot = input.projectRoot
  const plan = planUpgrade(db, { toolRoot: input.toolRoot, configPath: input.configPath, from: input.from })

  if (!plan.outdated) return { applied: false, plan }
  if (!input.yes) return { applied: false, plan }

  const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, '-')
  const backup = `${input.dbPath}.backup-${stamp}`
  db.exec(`vacuum into '${backup.replace(/'/g, "''")}'`)

  migrate(db)

  const journal = writeUpgradeJournal(projectRoot, {
    from: plan.current.current,
    to: plan.current.latest ?? plan.current.current,
    schemaFrom: plan.schemaFrom,
    schemaTo: plan.schemaTo,
    backup,
    files: input.root === toolRoot
      ? []
      : refreshOpenCode(projectRoot, plan.current.latest ?? plan.current.current, { yes: true })
          .filter((item) => item.status !== 'same')
          .map((item) => item.path),
    now: input.now,
  })
  void journal

  const target = plan.current.latest ?? plan.current.current
  if (existsSync(input.configPath)) {
    const raw = readFileSync(input.configPath, 'utf8').replace(/^\uFEFF/, '')
    const config = JSON.parse(raw) as Record<string, unknown>
    writeFileSync(
      input.configPath,
      JSON.stringify({ ...config, toolVersion: target, schemaVersion: plan.schemaTo }, null, 2) + '\n',
      'utf8',
    )
  }

  return { applied: true, backup, plan }
}
