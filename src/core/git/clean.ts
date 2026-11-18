import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, isAbsolute, join, relative as relativePath } from 'node:path'
import { spawnSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { slugify } from '../ids.ts'
import { DEFAULT_CONFIG } from '../config.ts'
import { getFeature, listFeatures, type Feature } from '../features.ts'
import { appendEvent } from '../events.ts'
import { branchExists, isRepo, resolveBranches, runGit } from './git.ts'
import { isRegisteredWorktree, poolSlotOf, resetSlot } from './worktree.ts'
import { UserError } from '../../cli/errors.ts'

export function featureSlug(feature: Feature): string {
  return `${feature.id.toLowerCase()}-${slugify(feature.name)}`
}

export function archiveTag(feature: Feature): string {
  return `archive/${featureSlug(feature)}`
}

export interface CleanResult {
  removed: boolean
  /** Каталог вернулся в пул: он на месте, но сброшен на dev. */
  returned?: boolean
  rescued: boolean
  tag: string | null
  reason?: string
}

/**
 * Убирает рабочий каталог фичи. Грязь не теряется: она коммитится в ветку,
 * а голова ветки получает тег archive/, чтобы наработки можно было забрать.
 *
 * При пуле каталог не удаляется, а возвращается в пул (сброс на dev): ветка
 * остаётся у фичи, слот достаётся следующей. Без пула — прежнее удаление.
 */
export function cleanWorktree(
  db: DatabaseSync,
  input: {
    featureId: string
    root: string
    actor: string
    config?: { branches: { main: string; dev: string }; worktreePool?: number | undefined }
  },
): CleanResult {
  const feature = getFeature(db, input.featureId)
  if (!feature) throw new UserError(3, `фича ${input.featureId} не найдена`)

  const dir = feature.worktree
  if (!dir) return { removed: false, rescued: false, tag: null }

  if (!existsSync(dir)) {
    db.prepare('update features set worktree = null where id = ?').run(feature.id)
    return { removed: false, rescued: false, tag: null }
  }

  const registered = isRepo(input.root) && isRegisteredWorktree(input.root, dir)
  const ignored = registered
    ? runGit(dir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'])
        .split('\0')
        .filter(Boolean)
    : []
  const dirty =
    registered && runGit(dir, ['status', '--porcelain', '--untracked-files=normal']).length > 0
  let tag: string | null = null
  let rescued = false

  // ignored-файлы не тащим в git: секреты и node_modules в истории недопустимы.
  // Складываем их рядом, в .toolbox-al/rescued, который сам игнорируется.
  if (ignored.length > 0) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const target = join(input.root, '.toolbox-al', 'rescued', featureSlug(feature), stamp)

    for (const relative of ignored) {
      const from = join(dir, relative)
      if (!existsSync(from)) continue
      const to = join(target, relative)
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
    }

    appendEvent(db, {
      type: 'feature.ignored_rescued',
      actor: input.actor,
      subject: feature.id,
      after: { dir: target, files: ignored.length },
    })
  }

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

  // пул: каталог не удаляем, а сбрасываем на dev — слот достанется следующей фиче.
  // Только при включённом пуле: merge и прямые вызовы без конфига убирают как раньше.
  const poolSize = input.config?.worktreePool ?? 0
  const slot = poolSize > 0 ? poolSlotOf(input.root, dir) : null
  if (slot) {
    const { dev } = resolveBranches(input.root, input.config ?? DEFAULT_CONFIG)
    try {
      resetSlot(input.root, slot, dev)
    } catch (error) {
      const reason =
        `${(error as Error).message}. Слот ${slot} не вернулся в пул: ` +
        'закройте процесс, который держит каталог, и повторите feature clean'
      appendEvent(db, {
        type: 'feature.cleanup_skipped',
        actor: input.actor,
        subject: feature.id,
        note: reason,
      })
      return { removed: false, returned: false, rescued, tag, reason }
    }

    db.prepare('update features set worktree = null where id = ?').run(feature.id)
    appendEvent(db, {
      type: 'feature.slot_returned',
      actor: input.actor,
      subject: feature.id,
      after: { slot, branch: feature.branch, dev },
    })
    return { removed: false, returned: true, rescued, tag }
  }

  // каталог, снятый с учёта git, можно удалять напрямую — но только если он наш
  if (!registered) {
    const relative = relativePath(input.root, dir)
    if (!relative || relative.startsWith('..') || isAbsolute(relative)) {
      const reason = `каталог ${dir} вне .worktrees проекта: удалять его нельзя`
      appendEvent(db, {
        type: 'feature.cleanup_skipped',
        actor: input.actor,
        subject: feature.id,
        note: reason,
      })
      return { removed: false, rescued, tag, reason }
    }
  }

  try {
    // на Windows нельзя удалить каталог, внутри которого стоит процесс
    const cwd = process.cwd()
    if (cwd === dir || cwd.startsWith(dir + (process.platform === 'win32' ? '\\' : '/'))) {
      process.chdir(input.root)
    }

    // после неудачной уборки git может снять каталог с учёта, оставив пустую папку:
    // такое удаляем напрямую, иначе остаток не убрать уже никогда
    if (registered) {
      runGit(input.root, ['worktree', 'remove', '--force', dir])
    } else {
      rmSync(dir, { recursive: true, force: true })
    }
  } catch (error) {
    const reason = `${(error as Error).message}. Закройте процесс, который держит каталог, и повторите feature clean`
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
  worktreePool?: number | undefined
}

/**
 * Удаление ветки не должно валить слияние: если ветку держит рабочий каталог,
 * оставляем её до следующей уборки и говорим об этом событием.
 */
function tryDeleteBranch(
  db: DatabaseSync,
  root: string,
  branch: string,
  featureId: string,
  actor: string,
): boolean {
  try {
    runGit(root, ['branch', '-D', branch])
    return true
  } catch (error) {
    appendEvent(db, {
      type: 'feature.cleanup_skipped',
      actor,
      subject: featureId,
      note: `${branch}: ${(error as Error).message}`,
    })
    return false
  }
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

      if (!tryDeleteBranch(db, input.root, branch, feature.id, input.actor)) {
        result.kept.push(branch)
        continue
      }
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

    const cleaned = cleanWorktree(db, {
      featureId: feature.id,
      root: input.root,
      actor: input.actor,
      config: input.config,
    })
    if (cleaned.reason) {
      if (feature.branch) result.kept.push(feature.branch)
      continue
    }

    const branch = feature.branch
    if (!branch || !branchExists(input.root, branch)) continue

    const tag = archiveTag(feature)
    try {
      runGit(input.root, ['tag', '-f', tag, branch])
      runGit(input.root, ['branch', '-D', branch])
    } catch (error) {
      // уборка не должна валить слияние: занятую каталогом ветку оставим до следующего раза
      appendEvent(db, {
        type: 'feature.cleanup_skipped',
        actor: input.actor,
        subject: feature.id,
        note: `${branch}: ${(error as Error).message}`,
      })
      result.kept.push(branch)
      continue
    }
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

export interface StaleBranch {
  featureId: string
  branch: string
  why: string
}

/** Ветки закрытых фич, которые выдержка уже прошла, но убрать их нельзя без решения владельца. */
export function staleBranches(
  db: DatabaseSync,
  input: { root: string; config: SweepConfig; now?: Date },
): StaleBranch[] {
  const { dev } = resolveBranches(input.root, input.config)
  const retentionMs = (input.config.branchRetentionDays ?? 30) * 86_400_000
  const now = (input.now ?? new Date()).getTime()
  const stale: StaleBranch[] = []

  for (const feature of listFeatures(db)) {
    if (feature.status !== 'done' || !feature.branch) continue
    const branch = feature.branch
    if (!branchExists(input.root, branch)) continue

    const last = Date.parse(runGit(input.root, ['log', '-1', '--format=%cI', branch]))
    if (Number.isNaN(last) || now - last < retentionMs) continue
    if (isMergedInto(input.root, branch, dev)) continue

    const tag = runGit(input.root, ['tag', '--list', archiveTag(feature)])
    if (tag) continue

    stale.push({ featureId: feature.id, branch, why: 'не влита в dev и нет архивного тега' })
  }

  return stale
}

function isMergedInto(root: string, branch: string, dev: string): boolean {
  const result = spawnSync('git', ['merge-base', '--is-ancestor', branch, dev], {
    cwd: root,
    stdio: 'ignore',
    windowsHide: true,
  })
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
    config: { branches: { main: string; dev: string }; worktreePool?: number | undefined }
    actor: string
  },
): FeatureCleanResult {
  const feature = getFeature(db, input.featureId)
  if (!feature) throw new UserError(3, `фича ${input.featureId} не найдена`)
  if (feature.status !== 'done' && feature.status !== 'cancelled') {
    throw new UserError(1, `фича ${feature.id} в статусе ${feature.status}: clean не трогает незакрытые`)
  }

  const cleaned = cleanWorktree(db, {
    featureId: feature.id,
    root: input.root,
    actor: input.actor,
    config: input.config,
  })
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










