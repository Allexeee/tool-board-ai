import { existsSync } from 'node:fs'
import type { DatabaseSync } from 'node:sqlite'
import { slugify } from '../ids.ts'
import { getFeature, type Feature } from '../features.ts'
import { appendEvent } from '../events.ts'
import { runGit } from './git.ts'
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
