import type { DatabaseSync } from 'node:sqlite'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { listCards } from './cards.ts'
import { getExecutor } from './executors.ts'
import { isRepo, refreshMergeState, resolveBranches, runGit } from './git.ts'
import { reclaimExpired } from './runs.ts'
import { SCHEMA_VERSION, schemaVersionOf } from './schema.ts'

export interface DoctorResult {
  errors: string[]
  warnings: string[]
}

/**
 * Диагностика доски (§12 `board doctor`). Ошибки — доска не настроена или
 * несовместима; предупреждения — рабочее состояние, требующее внимания.
 * Git остаётся источником истины по мержу: кэш `in_dev`/`in_main` пересчитывается
 * для карточек с `merge_commit`, когда репозиторий доступен (§7.3).
 */
export function doctorData(db: DatabaseSync, root: string): DoctorResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!existsSync(join(root, '.board', 'board.db'))) {
    errors.push('.board/board.db не найден: выполните board init')
  }

  const repo = isRepo(root)
  if (!repo) {
    errors.push('не git-репозиторий: ветки и коммиты недоступны')
  } else {
    const { main, dev } = resolveBranches(root)
    if (!branchExists(root, main)) errors.push(`ветки ${main} нет: релиз некуда сливать`)
    if (!branchExists(root, dev)) errors.push(`ветки ${dev} нет: карточкам некуда сливаться`)
  }

  // Схему проверяем до любых запросов к таблицам: при расхождении их может не быть.
  const version = schemaVersionOf(db)
  if (version !== SCHEMA_VERSION) {
    errors.push(`схема ${version} не совпадает с ожидаемой ${SCHEMA_VERSION}`)
    return { errors, warnings }
  }

  if (!getExecutor(db, 'owner')) {
    errors.push('нет исполнителя owner: выполните board init')
  }

  const reclaimed = reclaimExpired(db)
  if (reclaimed > 0) {
    warnings.push(`lease истёк у ${reclaimed} забегов: карточки возвращены в очередь`)
  }

  if (repo) {
    refreshMergeStateFor(db, root, warnings)
    checkWorktrees(root, warnings)
  }

  checkCards(db, warnings)

  return { errors, warnings }
}

function branchExists(root: string, name: string): boolean {
  try {
    runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    return true
  } catch {
    return false
  }
}

/** Пересчитывает `in_dev`/`in_main`; при недоступности git — предупреждение. */
function refreshMergeStateFor(db: DatabaseSync, root: string, warnings: string[]): void {
  for (const card of listCards(db)) {
    if (card.mergeCommit === null) continue
    try {
      refreshMergeState(db, root, card)
    } catch {
      warnings.push(`git недоступен: состояние in_dev/in_main карточки ${card.id} не обновлено`)
      break
    }
  }
}

/** Зарегистрированные в git worktree под `.worktrees/`: пропавшие или грязные. */
function checkWorktrees(root: string, warnings: string[]): void {
  const wtDir = normalizePath(join(root, '.worktrees'))
  for (const path of registeredWorktrees(root)) {
    if (!normalizePath(path).startsWith(wtDir + '/')) continue
    if (!existsSync(path)) {
      warnings.push(`worktree ${path} зарегистрирован, но каталога нет`)
      continue
    }
    try {
      if (runGit(path, ['status', '--porcelain']) !== '') {
        warnings.push(`worktree ${path} грязный: закоммитьте или откатите изменения`)
      }
    } catch {
      warnings.push(`worktree ${path} не удалось проверить`)
    }
  }
}

function registeredWorktrees(root: string): string[] {
  try {
    return runGit(root, ['worktree', 'list', '--porcelain'])
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length).trim())
      .filter(Boolean)
  } catch {
    return []
  }
}

/** Карточки, мешающие релизу: код в dev без done, критические находки, ревью. */
function checkCards(db: DatabaseSync, warnings: string[]): void {
  const cards = listCards(db)

  const inDevNotDone = cards.filter(
    (card) => card.inDev && card.status !== 'done' && card.revertedAt === null,
  )
  if (inDevNotDone.length > 0) {
    warnings.push(
      `в dev есть карточки не done: ${inDevNotDone.map((c) => `${c.id} (${c.status})`).join(', ')}`,
    )
  }

  const critical = cards.filter(
    (card) => card.severity === 'critical' && card.status !== 'done' && card.status !== 'cancelled',
  )
  if (critical.length > 0) {
    warnings.push(`открыты критические находки (critical): ${critical.map((c) => c.id).join(', ')}`)
  }

  const review = cards.filter((card) => card.status === 'review')
  if (review.length > 0) {
    warnings.push(`карточки на ревью: ${review.map((c) => c.id).join(', ')}`)
  }
}

function normalizePath(path: string): string {
  return resolve(path).replace(/\\/g, '/').toLowerCase()
}
