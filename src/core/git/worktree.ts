import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { slugify } from '../ids.ts'
import { getFeature, setFeatureBranch } from '../features.ts'
import { branchExists, isRepo, resolveBranches, runGit } from './git.ts'
import { UserError } from '../../cli/errors.ts'

export function worktreePath(root: string, slug: string): string {
  return join(root, '.worktrees', slug)
}

export function startFeature(
  db: DatabaseSync,
  input: { root: string; featureId: string; config: { branches: { main: string; dev: string } } },
): { branch: string; worktree: string } {
  if (!isRepo(input.root)) throw new UserError(3, `не git-репозиторий: ${input.root}`)

  const feature = getFeature(db, input.featureId)
  if (!feature) throw new UserError(3, `фича ${input.featureId} не найдена`)

  const slug = `${feature.id.toLowerCase()}-${slugify(feature.name)}`
  const branch = `feat/${slug}`
  const worktree = worktreePath(input.root, slug)

  if (feature.branch === branch && feature.worktree === worktree && existsSync(worktree)) {
    return { branch, worktree }
  }

  if (!existsSync(worktree)) {
    mkdirSync(join(input.root, '.worktrees'), { recursive: true })

    if (branchExists(input.root, branch)) {
      runGit(input.root, ['worktree', 'add', worktree, branch])
    } else {
      const { dev } = resolveBranches(input.root, input.config)
      if (!branchExists(input.root, dev)) {
        throw new UserError(3, `ветки ${dev} нет: создайте её перед началом фичи`)
      }
      runGit(input.root, ['worktree', 'add', '-b', branch, worktree, dev])
    }
  }

  setFeatureBranch(db, feature.id, branch, worktree)
  return { branch, worktree }
}
