import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { branchExists, currentBranch, resolveBranches, runGit } from './git.ts'
import { appendEvent } from '../events.ts'
import { availableVersions } from '../upgrade.ts'
import { UserError } from '../../cli/errors.ts'

export type ReleaseLevel = 'major' | 'minor' | 'patch'

export interface PendingStage {
  featureId: string
  featureName: string
  stageId: string
  stageName: string
  mergedAt: string
}

// что уже в dev, но ещё не уехало в main: этапы, слитые после прошлого релиза
export function pendingRelease(db: DatabaseSync): PendingStage[] {
  const lastRelease = db.prepare('select max(at) as at from releases').get() as { at: string | null }

  return db
    .prepare(
      `select f.id as featureId, f.name as featureName, s.id as stageId, s.name as stageName, s.merged_at as mergedAt
       from stages s join features f on f.id = s.feature_id
       where s.status = 'merged' and s.merged_at > ?
       order by f.rank, s.seq`,
    )
    .all(lastRelease.at ?? '0000-00-00') as unknown as PendingStage[]
}

export interface LevelSuggestion {
  version: string
  level: 'minor' | 'patch'
  tasks: number
  features: number
  fixes: number
}

/** Что выпустим и каким уровнем: новые возможности — minor, только исправления — patch. */
export function suggestLevel(db: DatabaseSync, root: string): LevelSuggestion | null {
  const stages = pendingRelease(db)
  if (stages.length === 0) return null

  const placeholders = stages.map(() => '?').join(', ')
  const rows = db
    .prepare(`select kind from tasks where stage_id in (${placeholders}) and status = 'done'`)
    .all(...stages.map((stage) => stage.stageId)) as Array<{ kind: string }>

  const features = rows.filter((row) => row.kind === 'task').length
  const fixes = rows.length - features

  return {
    version: currentVersion(db, root),
    level: features > 0 ? 'minor' : 'patch',
    tasks: rows.length,
    features,
    fixes,
  }
}

export interface ReleaseResult {
  released: boolean
  version?: string
  tag?: string
  changelog?: string
  reason?: string
}

function metaVersion(db: DatabaseSync): string | null {
  const row = db.prepare("select value from meta where key = 'version'").get() as { value: string } | undefined
  return row?.value ?? null
}

function releasedVersion(db: DatabaseSync): string | null {
  const row = db.prepare('select max(version) as version from releases').get() as
    | { version: string | null }
    | undefined
  return row?.version ?? null
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** База — наибольшее из сохранённых версий и тегов репозитория: тег переживает потерю базы. */
function currentVersion(db: DatabaseSync, root: string): string {
  const candidates = [metaVersion(db), releasedVersion(db), ...availableVersions(root)]
    .filter((value): value is string => Boolean(value && /^\d+\.\d+\.\d+$/.test(value)))
    .sort(compareVersions)

  return candidates.at(-1) ?? '0.1.0'
}

function bump(version: string, level: ReleaseLevel): string {
  const [major, minor, patch] = version.split('.').map(Number)
  if (level === 'major') return `${major + 1}.0.0`
  if (level === 'minor') return `${major}.${minor + 1}.0`
  return `${major}.${minor}.${patch + 1}`
}

export function release(
  db: DatabaseSync,
  input: {
    root: string
    level: ReleaseLevel
    reason?: string
    config: { branches: { main: string; dev: string } }
    actor: string
  },
): ReleaseResult {
  const lastRelease = db.prepare('select max(at) as at from releases').get() as { at: string | null }
  const since = lastRelease.at ?? '0000-00-00'

  const stages = db
    .prepare(
      `select s.id as id, s.name as stage, f.name as feature
       from stages s join features f on f.id = s.feature_id
       where s.status = 'merged' and s.merged_at > ?
       order by s.merged_at`,
    )
    .all(since) as Array<{ id: string; stage: string; feature: string }>

  if (stages.length === 0) {
    return { released: false, reason: 'нет слитых этапов с прошлого релиза' }
  }

  const { main, dev } = resolveBranches(input.root, input.config)
  if (!branchExists(input.root, main)) throw new UserError(3, `ветки ${main} нет`)
  if (!branchExists(input.root, dev)) throw new UserError(3, `ветки ${dev} нет`)

  const version = bump(currentVersion(db, input.root), input.level)
  const tag = `v${version}`
  const date = new Date().toISOString().slice(0, 10)
  const changelog =
    `## ${tag} — ${date}\n\n` +
    (input.reason ? `${input.reason}\n\n` : '') +
    stages.map((stage) => `- ${stage.feature} — ${stage.stage}`).join('\n')

  const dirty = runGit(input.root, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty) {
    throw new UserError(3, 'дерево грязное: релиз не начинается, закоммитьте или уберите изменения')
  }

  const original = currentBranch(input.root)
  runGit(input.root, ['checkout', main])
  try {
    try {
      runGit(input.root, ['merge', '--no-ff', dev, '-m', `merge: ${dev} → ${main}`], { AL_ALLOW: '1' })
    } catch (error) {
      try {
        runGit(input.root, ['merge', '--abort'])
      } catch {
        appendEvent(db, { type: 'release.abort_failed', actor: input.actor, subject: tag })
      }
      throw error
    }

    const changelogPath = join(input.root, 'CHANGELOG.md')
    const previous = existsSync(changelogPath) ? readFileSync(changelogPath, 'utf8') : '# Changelog\n\n'
    writeFileSync(changelogPath, previous.trimEnd() + '\n\n' + changelog + '\n')
    runGit(input.root, ['add', 'CHANGELOG.md'])
    runGit(input.root, ['commit', '-m', `chore: release ${tag}`], { AL_ALLOW: '1' })
    runGit(input.root, ['tag', tag])
  } finally {
    if (original && original !== main) {
      try {
        runGit(input.root, ['checkout', original])
      } catch {
        appendEvent(db, { type: 'branch.restore_failed', actor: input.actor, subject: tag })
      }
    }
  }

  db.prepare("insert or replace into meta (key, value) values ('version', ?)").run(version)
  db.prepare('insert into releases (version, tag, changelog, at) values (?, ?, ?, ?)').run(
    version,
    tag,
    changelog,
    new Date().toISOString(),
  )
  appendEvent(db, {
    type: 'release.created',
    actor: input.actor,
    subject: tag,
    after: { version, level: input.level, reason: input.reason ?? null, stages: stages.map((stage) => stage.id) },
  })

  return { released: true, version, tag, changelog }
}

