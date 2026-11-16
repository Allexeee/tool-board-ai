import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { slugify } from '../ids.ts'
import { getFeature, listFeatures, type Feature } from '../features.ts'
import { appendEvent } from '../events.ts'
import { branchExists, resolveBranches, runGit } from './git.ts'
import { UserError } from '../../cli/errors.ts'

export function featureSlug(feature: Feature): string {
  return `${feature.id.toLowerCase()}-${slugify(feature.name)}`
}

export function archiveTag(feature: Feature): string {
  return `archive/${featureSlug(feature)}`
}

export interface CleanResult {
  removed: boolean
  rescued: boolean
  tag: string | null
  reason?: string
}

/**
 * Убирает рабочий каталог фичи. Грязь не теряется: она коммитится в ветку,
 * а голова ветки получает тег archive/, чтобы наработки можно было забрать.
 */
export function cleanWorktree(
  db: DatabaseSync,
  input: { featureId: string; root: string; actor: string },
): CleanResult {
  const feature = getFeature(db, input.featureId)
  if (!feature) throw new UserError(3, `фича ${input.featureId} не найдена`)

  const dir = feature.worktree
  if (!dir) return { removed: false, rescued: false, tag: null }

  if (!existsSync(dir)) {
    db.prepare('update features set worktree = null where id = ?').run(feature.id)
    return { removed: false, rescued: false, tag: null }
  }

  const dirty = runGit(dir, ['status', '--porcelain', '--untracked-files=normal']).length > 0
  let tag: string | null = null
  let rescued = false

  if (dirty) {
    try {
      runGit(dir, ['add', '-A'])
      runGit(dir, ['commit', '-m', `wip: остатки ${feature.id} перед уборкой`])
      tag = archiveTag(feature)
      runGit(dir, ['tag', '-f', tag, 'HEAD'])
      rescued = true
    } catch (error) {
      const reason = (error as Error).message
      appendEvent(db, {
        type: 'feature.cleanup_skipped',
        actor: input.actor,
        subject: feature.id,
        note: reason,
      })
      return { removed: false, rescued: false, tag: null, reason }
    }
  }

  try {
    // на Windows нельзя удалить каталог, внутри которого стоит процесс
    const cwd = process.cwd()
    if (cwd === dir || cwd.startsWith(dir + (process.platform === 'win32' ? '\\' : '/'))) {
      process.chdir(input.root)
    }
    runGit(input.root, ['worktree', 'remove', '--force', dir])
  } catch (error) {
    const reason = (error as Error).message
    appendEvent(db, {
      type: 'feature.cleanup_skipped',
      actor: input.actor,
      subject: feature.id,
      note: reason,
    })
    return { removed: false, rescued, tag, reason }
  }

  db.prepare('update features set worktree = null where id = ?').run(feature.id)
  appendEvent(db, {
    type: 'feature.cleaned',
    actor: input.actor,
    subject: feature.id,
    after: { branch: feature.branch, tag, rescued },
  })

  return { removed: true, rescued, tag }
}

export interface SweepResult {
  deleted: string[]
  kept: string[]
}

interface SweepConfig {
  branches: { main: string; dev: string }
  branchRetentionDays?: number
}

/** Убирает то, что уже не нужно: слитые старые ветки и отменённые фичи после выдержки. */
export function sweepBranches(
  db: DatabaseSync,
  input: { root: string; config: SweepConfig; actor: string; now?: Date },
): SweepResult {
  const result: SweepResult = { deleted: [], kept: [] }
  const { dev } = resolveBranches(input.root, input.config)
  const retentionMs = (input.config.branchRetentionDays ?? 30) * 86_400_000
  const now = (input.now ?? new Date()).getTime()

  for (const feature of listFeatures(db)) {
    if (feature.status === 'done') {
      if (!feature.branch) continue
      const branch = feature.branch
      if (!branchExists(input.root, branch)) continue

      const merged = isMergedInto(input.root, branch, dev)
      const last = Date.parse(runGit(input.root, ['log', '-1', '--format=%cI', branch]))

      if (!merged || Number.isNaN(last) || now - last < retentionMs) {
        result.kept.push(branch)
        continue
      }

      runGit(input.root, ['branch', '-D', branch])
      db.prepare('update features set branch = null where id = ?').run(feature.id)
      appendEvent(db, {
        type: 'feature.branch_deleted',
        actor: input.actor,
        subject: feature.id,
        after: { branch, reason: 'merged-retention' },
      })
      result.deleted.push(branch)
      continue
    }

    if (feature.status !== 'cancelled') continue

    const abandoned = db
      .prepare("select at from events where type = 'feature.abandoned' and subject = ? order by id desc limit 1")
      .get(feature.id) as { at: string } | undefined
    const since = Date.parse(abandoned?.at ?? feature.createdAt)
    if (Number.isNaN(since) || now - since < retentionMs) {
      if (feature.branch) result.kept.push(feature.branch)
      continue
    }

    const cleaned = cleanWorktree(db, { featureId: feature.id, root: input.root, actor: input.actor })
    if (cleaned.reason) {
      if (feature.branch) result.kept.push(feature.branch)
      continue
    }

    const branch = feature.branch
    if (!branch || !branchExists(input.root, branch)) continue

    const tag = archiveTag(feature)
    runGit(input.root, ['tag', '-f', tag, branch])
    runGit(input.root, ['branch', '-D', branch])
    db.prepare('update features set branch = null where id = ?').run(feature.id)
    appendEvent(db, {
      type: 'feature.branch_deleted',
      actor: input.actor,
      subject: feature.id,
      after: { branch, tag, reason: 'cancelled-retention' },
    })
    result.deleted.push(branch)
  }

  return result
}

function isMergedInto(root: string, branch: string, dev: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', branch, dev], { cwd: root, stdio: 'ignore' })
  return result.status === 0
}

export interface FeatureCleanResult extends CleanResult {
  branchDeleted: boolean
}

/** Ручная уборка: каталог всегда, ветку — по флагу. Незакрытую фичу не трогаем. */
export function cleanFeature(
  db: DatabaseSync,
  input: {
    featureId: string
    root: string
    branch: boolean
    config: { branches: { main: string; dev: string } }
    actor: string
  },
): FeatureCleanResult {
  const feature = getFeature(db, input.featureId)
  if (!feature) throw new UserError(3, `фича ${input.featureId} не найдена`)
  if (feature.status !== 'done' && feature.status !== 'cancelled') {
    throw new UserError(1, `фича ${feature.id} в статусе ${feature.status}: clean не трогает незакрытые`)
  }

  const cleaned = cleanWorktree(db, { featureId: feature.id, root: input.root, actor: input.actor })
  if (!input.branch) return { ...cleaned, branchDeleted: false }

  const branch = feature.branch
  if (!branch) return { ...cleaned, branchDeleted: false }
  if (cleaned.reason) {
    throw new UserError(1, `ветку ${branch} не удалить: каталог остался (${cleaned.reason})`)
  }
  if (!branchExists(input.root, branch)) return { ...cleaned, branchDeleted: false }

  const { dev } = resolveBranches(input.root, input.config)
  const merged = isMergedInto(input.root, branch, dev)
  const tag = archiveTag(feature)
  if (!merged) runGit(input.root, ['tag', '-f', tag, branch])

  runGit(input.root, ['branch', '-D', branch])
  appendEvent(db, {
    type: 'feature.branch_deleted',
    actor: input.actor,
    subject: feature.id,
    after: { branch, tag: merged ? null : tag },
  })
  db.prepare('update features set branch = null where id = ?').run(feature.id)

  return { ...cleaned, branchDeleted: true }
}

