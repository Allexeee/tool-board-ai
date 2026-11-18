import { existsSync, mkdirSync } from 'node:fs'
import { join, relative as relativePath } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { slugify } from '../ids.ts'
import { DEFAULT_CONFIG } from '../config.ts'
import { getFeature, listFeatures, setFeatureBranch, type Feature } from '../features.ts'
import { branchExists, isRepo, resolveBranches, runGit } from './git.ts'
import { UserError } from '../../cli/errors.ts'

export interface WorktreeConfig {
  branches: { main: string; dev: string }
  /** Сколько рабочих каталогов держать в пуле; 0 — каталог на каждую фичу, как раньше. */
  worktreePool?: number | undefined
}

export function worktreePath(root: string, slug: string): string {
  return join(root, '.worktrees', slug)
}

/** Слот пула: .worktrees/pool-1, pool-2, … — каталог переиспользуется, ветка остаётся у фичи. */
export function slotPath(root: string, index: number): string {
  return worktreePath(root, `pool-${index}`)
}

/** Слот по пути. Каталог фичи (f1-…) слотом не считается, даже если лежит рядом. */
export function poolSlotOf(root: string, dir: string): string | null {
  const normalized = relativePath(root, dir).replace(/\\/g, '/')
  return /^\.worktrees\/pool-\d+$/i.test(normalized) ? dir : null
}

const normalizePath = (value: string): string => value.replace(/\\/g, '/').toLowerCase()

/** Каталог числится за git рабочим каталогом: его можно сбросить, а не создавать заново. */
export function isRegisteredWorktree(root: string, dir: string): boolean {
  const wanted = normalizePath(dir)
  return runGit(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .some((line) => normalizePath(line.slice('worktree '.length).trim()) === wanted)
}

const alreadyCheckedOut = (error: unknown): boolean => /already checked out/i.test((error as Error).message)

/** Ветку нельзя взять вторым каталогом: тогда голова отвязана, содержимое то же. */
function addWorktree(root: string, worktree: string, dev: string): void {
  try {
    runGit(root, ['worktree', 'add', worktree, dev])
  } catch (error) {
    if (!alreadyCheckedOut(error)) throw error
    runGit(root, ['worktree', 'add', '--detach', worktree, dev])
  }
}

/**
 * Слот возвращается в пул: голова на dev, рабочая копия чистая (checkout,
 * reset --hard, clean -ffdx). Ветка фичи остаётся в репозитории — её не трогаем.
 *
 * Каталог, которого git не знает, не затираем: это может быть чужая работа.
 * Такой слот — ошибка с объяснением, а не тихая выдача.
 */
export function resetSlot(root: string, slot: string, dev: string): void {
  if (!branchExists(root, dev)) {
    throw new UserError(3, `ветки ${dev} нет: слоту ${slot} некуда возвращаться`)
  }

  if (!existsSync(slot)) {
    runGit(root, ['worktree', 'prune'])
    addWorktree(root, slot, dev)
    return
  }

  if (!isRegisteredWorktree(root, slot)) {
    throw new UserError(
      1,
      `слот ${slot} занят посторонним каталогом: git его не знает — ` +
        'уберите каталог вручную, чтобы слот вернулся в пул',
    )
  }

  try {
    runGit(slot, ['checkout', '-f', dev])
  } catch (error) {
    if (!alreadyCheckedOut(error)) throw error
    runGit(slot, ['checkout', '-f', '--detach', dev])
  }
  runGit(slot, ['reset', '--hard', dev])
  // двойной -f убирает и вложенные репозитории: следов прошлой фичи не остаётся
  runGit(slot, ['clean', '-ffdx'])
}

function poolSizeOf(config: WorktreeConfig): number {
  const size = config.worktreePool ?? DEFAULT_CONFIG.worktreePool
  return typeof size === 'number' && Number.isInteger(size) && size > 0 ? size : 0
}

/**
 * Свободный слот: тот, на который не ссылается ни одна фича. Ссылка снимается
 * только уборкой (`feature clean`), поэтому закрытая, но не убранная фича
 * каталог не отдаёт — иначе её наработки затёрлись бы чужой выдачей.
 */
function takeSlot(db: DatabaseSync, root: string, feature: Feature, size: number): string {
  const features = listFeatures(db)

  for (let index = 1; index <= size; index++) {
    const slot = slotPath(root, index)
    const wanted = normalizePath(slot)
    const owner = features.find(
      (candidate) => candidate.worktree !== null && normalizePath(candidate.worktree) === wanted,
    )
    if (!owner || owner.id === feature.id) return slot
  }

  throw new UserError(
    1,
    `все слоты заняты, освободите feature clean или увеличьте worktreePool (слотов: ${size})`,
  )
}

/**
 * Начать фичу. При пуле каталог берётся из свободных слотов и сбрасывается на
 * dev: ветка фичи создаётся от dev, а слот переключается на неё. При
 * worktreePool: 0 — прежнее поведение: свой каталог на каждую фичу.
 */
export function startFeature(
  db: DatabaseSync,
  input: { root: string; featureId: string; config: WorktreeConfig },
): { branch: string; worktree: string } {
  if (!isRepo(input.root)) throw new UserError(3, `не git-репозиторий: ${input.root}`)

  const feature = getFeature(db, input.featureId)
  if (!feature) throw new UserError(3, `фича ${input.featureId} не найдена`)

  const slug = `${feature.id.toLowerCase()}-${slugify(feature.name)}`
  const branch = `feat/${slug}`

  // повторный старт не трогает каталог: в нём может идти работа
  if (feature.branch === branch && feature.worktree && existsSync(feature.worktree)) {
    return { branch, worktree: feature.worktree }
  }

  const { dev } = resolveBranches(input.root, input.config)
  const pool = poolSizeOf(input.config)
  const worktree = pool > 0 ? takeSlot(db, input.root, feature, pool) : worktreePath(input.root, slug)

  mkdirSync(join(input.root, '.worktrees'), { recursive: true })

  if (pool > 0) {
    if (!branchExists(input.root, dev)) {
      throw new UserError(3, `ветки ${dev} нет: создайте её перед началом фичи`)
    }

    // слот выдаётся пустым: ни чужой грязи, ни чужой головы
    if (existsSync(worktree)) resetSlot(input.root, worktree, dev)
    else addWorktree(input.root, worktree, dev)

    if (branchExists(input.root, branch)) runGit(worktree, ['checkout', '-f', branch])
    else runGit(worktree, ['checkout', '-b', branch, dev])
  } else if (!existsSync(worktree)) {
    if (branchExists(input.root, branch)) {
      runGit(input.root, ['worktree', 'add', worktree, branch])
    } else {
      if (!branchExists(input.root, dev)) {
        throw new UserError(3, `ветки ${dev} нет: создайте её перед началом фичи`)
      }
      runGit(input.root, ['worktree', 'add', '-b', branch, worktree, dev])
    }
  }

  setFeatureBranch(db, feature.id, branch, worktree)
  return { branch, worktree }
}
