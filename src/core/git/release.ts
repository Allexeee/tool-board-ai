import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { branchExists, currentBranch, resolveBranches, runGit } from './git.ts'
import { appendEvent } from '../events.ts'
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

export interface ReleaseResult {
  released: boolean
  version?: string
  tag?: string
  changelog?: string
  reason?: string
}

function currentVersion(db: DatabaseSync): string {
  const row = db.prepare("select value from meta where key = 'version'").get() as { value: string } | undefined
  return row?.value ?? '0.1.0'
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

  const version = bump(currentVersion(db), input.level)
  const tag = `v${version}`
  const date = new Date().toISOString().slice(0, 10)
  const changelog =
    `## ${tag} — ${date}\n\n` + stages.map((stage) => `- ${stage.feature} — ${stage.stage}`).join('\n')

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
    after: { version, stages: stages.map((stage) => stage.id) },
  })

  return { released: true, version, tag, changelog }
}
