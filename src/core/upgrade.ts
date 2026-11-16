import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DatabaseSync } from 'node:sqlite'

const here = dirname(fileURLToPath(import.meta.url))
export const toolRoot = join(here, '..', '..')

export function toolVersion(root = toolRoot): string {
  const raw = readFileSync(join(root, 'package.json'), 'utf8').replace(/^\uFEFF/, '')
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
