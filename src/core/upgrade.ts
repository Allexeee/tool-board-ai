import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'

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
