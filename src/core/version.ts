import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { UserError } from '../cli/errors.ts'
import { isRepo, runGit } from './git.ts'

export type BumpKind = 'patch' | 'minor' | 'major'

export function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

export function compareSemver(left: string, right: string): number {
  const a = parseSemver(left)
  const b = parseSemver(right)
  if (!a || !b) return 0
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}

function nextVersion(from: string, kind: BumpKind): string {
  const parts = parseSemver(from)
  if (!parts) throw new UserError(3, `версия ${from} не semver: нужен X.Y.Z`)
  const [major, minor, patch] = parts
  if (kind === 'major') return `${major + 1}.0.0`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

function today(): string {
  const date = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`
}

/** Bump semver в package.json, lock и CHANGELOG текущего проекта. */
export function bumpVersion(root: string, kind: BumpKind): { from: string; to: string } {
  if (isRepo(root) && runGit(root, ['status', '--porcelain']) !== '') {
    throw new UserError(3, 'рабочее дерево грязное: закоммитьте или откатите изменения перед bump')
  }

  const packagePath = join(root, 'package.json')
  if (!existsSync(packagePath)) {
    throw new UserError(3, 'package.json не найден: bump работает в проекте с package.json')
  }
  const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { version?: string }
  const from = pkg.version?.trim() ?? ''
  const to = nextVersion(from, kind)
  pkg.version = to
  writeJson(packagePath, pkg)

  const lockPath = join(root, 'package-lock.json')
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      version?: string
      packages?: Record<string, { version?: string }>
    }
    lock.version = to
    if (lock.packages?.['']) lock.packages[''].version = to
    writeJson(lockPath, lock)
  }

  const changelogPath = join(root, 'CHANGELOG.md')
  if (existsSync(changelogPath)) {
    const lines = readFileSync(changelogPath, 'utf8').split(/\r?\n/)
    const heading = `## v${to} — ${today()}`
    if (lines.some((line) => line.trim() === heading)) {
      throw new UserError(3, `запись ${heading} уже есть в CHANGELOG`)
    }
    const first = lines.findIndex((line) => line.startsWith('## '))
    if (first === -1) {
      lines.push(heading, '')
    } else {
      lines.splice(first, 0, heading, '')
    }
    writeFileSync(changelogPath, `${lines.join('\n').replace(/\n+$/, '')}\n`, 'utf8')
  }

  return { from, to }
}
