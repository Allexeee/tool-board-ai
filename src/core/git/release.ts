import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { branchExists, currentBranch, resolveBranches, runGit } from './git.ts'
import { tx } from '../db.ts'
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

// что уже в dev, но ещё не уехало в main: этапы, которых нет ни в одном релизе
export function pendingRelease(db: DatabaseSync): PendingStage[] {
  const released = new Set<string>()
  const rows = db.prepare("select after from events where type = 'release.created'").all() as Array<{
    after: string | null
  }>
  for (const row of rows) {
    if (!row.after) continue
    try {
      for (const id of (JSON.parse(row.after) as { stages?: string[] }).stages ?? []) released.add(id)
    } catch {
      // битое событие не должно прятать этапы
    }
  }

  const stages = db
    .prepare(
      `select f.id as featureId, f.name as featureName, s.id as stageId, s.name as stageName, s.merged_at as mergedAt
       from stages s join features f on f.id = s.feature_id
       where s.status = 'merged'
       order by f.rank, s.seq`,
    )
    .all() as unknown as PendingStage[]

  return stages.filter((stage) => !released.has(stage.stageId))
}

export interface DeferredTask {
  id: string
  title: string
  reason: string | null
  stageId: string
  featureId: string
}

/**
 * Отложенные задачи уже слитых этапов: в релиз они не входят, но и не исчезают.
 * Отчёт релиза показывает их, пока владелец не примет решение, — иначе пропуск был бы тихим.
 */
export function deferredInRelease(db: DatabaseSync): DeferredTask[] {
  const pending = new Set(pendingRelease(db).map((stage) => stage.stageId))
  return db
    .prepare(
      `select t.id as id, t.title as title, t.reason as reason, t.stage_id as stageId, s.feature_id as featureId
       from tasks t join stages s on s.id = t.stage_id
       where t.status = 'deferred' and s.status = 'merged'
       order by s.feature_id, t.created_at, t.id`,
    )
    .all()
    .filter((row) => pending.has((row as { stageId: string }).stageId)) as unknown as DeferredTask[]
}

/** Отложенное из уже выпущенных этапов: долг остался, но к будущему релизу не относится. */
export function deferredInReleased(db: DatabaseSync): Array<DeferredTask & { version: string | null }> {
  const pending = new Set(pendingRelease(db).map((stage) => stage.stageId))
  const versions = new Map<string, string>()
  for (const row of db.prepare("select after from events where type = 'release.created'").all() as Array<{
    after: string | null
  }>) {
    if (!row.after) continue
    try {
      const parsed = JSON.parse(row.after) as { version?: string; stages?: string[] }
      for (const id of parsed.stages ?? []) if (parsed.version) versions.set(id, parsed.version)
    } catch {
      // битое событие не должно прятать долг
    }
  }

  return (
    db
      .prepare(
        `select t.id as id, t.title as title, t.reason as reason, t.stage_id as stageId, s.feature_id as featureId
         from tasks t join stages s on s.id = t.stage_id
         where t.status = 'deferred' and s.status = 'merged'
         order by s.feature_id, t.created_at, t.id`,
      )
      .all() as unknown as DeferredTask[]
  )
    .filter((task) => !pending.has(task.stageId))
    .map((task) => ({ ...task, version: versions.get(task.stageId) ?? null }))
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
  const rows = db.prepare('select version from releases').all() as Array<{ version: string }>
  const versions = rows
    .map((row) => row.version)
    .filter((value) => /^\d+\.\d+\.\d+$/.test(value))
    .sort(compareVersions)
  return versions.at(-1) ?? null
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

/** Дата в формате проекта: 16.11.2026. */
function projectDate(now = new Date()): string {
  const [year, month, day] = now.toISOString().slice(0, 10).split('-')
  return `${day}.${month}.${year}`
}

/** Новая секция идёт сразу после заголовка файла: свежее сверху, старое не теряется. */
function insertChangelog(previous: string, section: string): string {
  const text = previous.replace(/^\uFEFF/, '').trim()
  if (!text) return `# Changelog\n\n${section}\n`

  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const body = section.split('\n').join(eol)
  const [first, ...rest] = text.split(/\r?\n/)
  const tail = rest.join(eol).trim()

  if (!first.startsWith('#')) return `# Changelog${eol}${eol}${body}${eol}${eol}${text}${eol}`

  return tail
    ? `${first}${eol}${eol}${body}${eol}${eol}${tail}${eol}`
    : `${first}${eol}${eol}${body}${eol}`
}

export function assertReleasePreflight(root: string, tag: string): void {
  if (runGit(root, ['tag', '--list', tag]).trim()) {
    throw new UserError(3, `тег ${tag} уже есть: релиз не начат, поднимите версию вручную`)
  }

  const changelogPath = join(root, 'CHANGELOG.md')
  if (existsSync(changelogPath) && readFileSync(changelogPath, 'utf8').includes(`## ${tag}`)) {
    throw new UserError(3, `в CHANGELOG уже есть раздел ${tag}: релиз не начат, проверьте историю`)
  }
}

export function release(
  db: DatabaseSync,
  input: {
    root: string
    level: ReleaseLevel
    reason?: string
    review?: 'same' | 'fresh' | 'none'
    config: { branches: { main: string; dev: string } }
    actor: string
  },
): ReleaseResult {
  const stages = pendingRelease(db).map((stage) => ({
    id: stage.stageId,
    stage: stage.stageName,
    feature: stage.featureName,
  }))

  if (stages.length === 0) {
    return { released: false, reason: 'нет слитых этапов с прошлого релиза' }
  }

  const { main, dev } = resolveBranches(input.root, input.config)
  if (!branchExists(input.root, main)) throw new UserError(3, `ветки ${main} нет`)
  if (!branchExists(input.root, dev)) throw new UserError(3, `ветки ${dev} нет`)

  const version = bump(currentVersion(db, input.root), input.level)
  const tag = `v${version}`
  assertReleasePreflight(input.root, tag)

  const date = projectDate()
  const changelog =
    `## ${tag} — ${date}\n\n` +
    (input.reason ? `${input.reason}\n\n` : '') +
    (input.review ? `ревью: ${input.review}\n\n` : '') +
    stages.map((stage) => `- ${stage.feature} — ${stage.stage}`).join('\n')

  const dirty = runGit(input.root, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty) {
    throw new UserError(3, 'дерево грязное: релиз не начинается, закоммитьте или уберите изменения')
  }

  const mainTip = runGit(input.root, ['rev-parse', main])
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
    writeFileSync(changelogPath, insertChangelog(previous, changelog))

    const pkgPath = join(input.root, 'package.json')
    const hasPackage = existsSync(pkgPath)
    if (hasPackage) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>
      writeFileSync(pkgPath, JSON.stringify({ ...pkg, version }, null, 2) + '\n', 'utf8')
    }

    runGit(input.root, ['add', 'CHANGELOG.md', ...(hasPackage ? ['package.json'] : [])])
    runGit(input.root, ['commit', '-m', `chore: release ${tag}`], { AL_ALLOW: '1' })
    runGit(input.root, ['tag', tag])
  } catch (error) {
    // релиз не состоялся — main возвращается туда, где был до попытки
    try {
      runGit(input.root, ['reset', '--hard', mainTip], { AL_ALLOW: '1' })
    } catch {
      appendEvent(db, { type: 'release.rollback_failed', actor: input.actor, subject: tag })
    }
    throw error
  } finally {
    if (original && original !== main) {
      try {
        runGit(input.root, ['checkout', original])
      } catch {
        appendEvent(db, { type: 'branch.restore_failed', actor: input.actor, subject: tag })
      }
    }
  }

  // тег уже стоит: база и история обновляются одной транзакцией, чтобы не разъехаться
  tx(db, () => {
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
      after: { version, level: input.level, reason: input.reason ?? null, review: input.review ?? null, stages: stages.map((stage) => stage.id) },
    })
  })

  return { released: true, version, tag, changelog }
}


