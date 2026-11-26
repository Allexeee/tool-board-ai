import type { DatabaseSync } from 'node:sqlite'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { listCards } from './cards.ts'
import { acceptancePaths, evaluateAcceptance } from './acceptance.ts'
import { getExecutor } from './executors.ts'
import { cardQueueClass, listQueue } from './queue.ts'
import { isRepo, refreshMergeState, resolveBranches, runGit } from './git.ts'
import { reclaimExpired } from './runs.ts'
import { hasReviewVerdict, hasReviewWaiver, packageCovers } from './review.ts'
import { findingsScope, modelContext, packageReviewRequired } from './review-policy.ts'
import { SCHEMA_VERSION, schemaVersionOf } from './schema.ts'
import { readSettings } from './settings.ts'
import { tagExists } from './tags.ts'
import { CONFLICTING_SKILLS_ADVICE, conflictingSkillsDisabled, SUPERPOWERS_ADVICE, superpowersConfigured } from './superpowers.ts'

export interface DoctorResult {
  errors: string[]
  warnings: string[]
  recommendations: string[]
}

/**
 * Диагностика доски (§12 `board doctor`). Ошибки — доска не настроена или
 * несовместима; предупреждения — рабочее состояние, требующее внимания.
 * Git остаётся источником истины по мержу: кэш `in_dev`/`in_main` пересчитывается
 * для карточек с `merge_commit`, когда репозиторий доступен (§7.3).
 */
export function doctorData(
  db: DatabaseSync,
  root: string,
  home: string = homedir(),
): DoctorResult {
  const errors: string[] = []
  const warnings: string[] = []
  const recommendations: string[] = superpowersConfigured(root, home) ? [] : [SUPERPOWERS_ADVICE]
  if (superpowersConfigured(root, home) && !conflictingSkillsDisabled(root, home)) {
    warnings.push(CONFLICTING_SKILLS_ADVICE)
  }

  if (!existsSync(join(root, '.board', 'board.db'))) {
    errors.push('.board/board.db не найден: выполните board init')
  }

  const settings = readSettings(root)
  const repo = settings.git && isRepo(root)
  if (!settings.git) {
    // Доска без git: ветки и мержи не нужны, это осознанный режим.
  } else if (!repo) {
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
    return { errors, warnings, recommendations }
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

  checkCards(
    db,
    warnings,
    findingsScope(settings, modelContext(process.env)),
    packageReviewRequired(settings, modelContext(process.env)),
  )
  checkAcceptance(db, root, settings, warnings)
  checkQueues(db, warnings)

  return { errors, warnings, recommendations }
}

/** Приёмка: согласованность флага, статуса и правил проекта. */
function checkAcceptance(
  db: DatabaseSync,
  root: string,
  settings: ReturnType<typeof readSettings>,
  warnings: string[],
): void {
  const cards = listCards(db)
  const withoutFlag = cards.filter(
    (card) => card.status === 'acceptance' && !card.ownerAcceptance,
  )
  if (withoutFlag.length > 0) {
    warnings.push(
      `в acceptance без флага приёмки: ${withoutFlag.map((card) => card.id).join(', ')}`,
    )
  }
  const ownerFlag = cards.filter(
    (card) => card.skill === 'owner' && card.ownerAcceptance,
  )
  if (ownerFlag.length > 0) {
    warnings.push(
      `флаг приёмки у owner-карточки: ${ownerFlag.map((card) => card.id).join(', ')}`,
    )
  }

  const acceptance = settings.acceptance
  const unknown = new Set<string>()
  const collect = (conditions: { tags?: string[] } | undefined): void => {
    for (const tag of conditions?.tags ?? []) {
      if (!tagExists(db, tag)) unknown.add(tag)
    }
  }
  collect(acceptance.exclude)
  for (const rule of acceptance.rules) {
    collect(rule.include)
    collect(rule.exclude)
  }
  if (unknown.size > 0) {
    warnings.push(`правила приёмки ссылаются на неизвестные теги: ${[...unknown].join(', ')}`)
  }

  for (const card of cards) {
    if (card.ownerAcceptanceManual || card.skill === 'owner') continue
    const decision = evaluateAcceptance(settings, card, acceptancePaths(root, card))
    if (decision.required !== card.ownerAcceptance) {
      warnings.push(
        `приёмка ${card.id} расходится с правилами: флаг ${card.ownerAcceptance ? 'да' : 'нет'}, правила ${decision.required ? 'да' : 'нет'}`,
      )
    }
  }
}

/** Позиции двух очередей: дубли, дыры и owner-карточки без позиции. */
function checkQueues(db: DatabaseSync, warnings: string[]): void {
  const groups = new Map<string, ReturnType<typeof listQueue>>()
  for (const card of listQueue(db)) {
    const key = cardQueueClass(card)
    groups.set(key, [...(groups.get(key) ?? []), card])
  }
  for (const [label, cards] of groups) {
    const missing = cards.filter((card) => card.position === null)
    if (missing.length > 0) {
      warnings.push(
        `${label}-очередь: без позиции ${missing.map((card) => card.id).join(', ')} — выполните board init`,
      )
    }
    const positions = cards
      .map((card) => card.position)
      .filter((position): position is number => position !== null)
      .sort((left, right) => left - right)
    const duplicates = positions.filter((position, index) => position === positions[index - 1])
    if (duplicates.length > 0) {
      warnings.push(`${label}-очередь: повторяются позиции ${[...new Set(duplicates)].join(', ')}`)
    }
    const gap = positions.some((position, index) => position !== index + 1)
    if (gap) warnings.push(`${label}-очередь: позиции с дырами — выполните queue reorder`)
  }
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
function checkCards(
  db: DatabaseSync,
  warnings: string[],
  findings: 'critical' | 'critical+important' = 'critical',
  packageRequired = true,
): void {
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

  if (findings === 'critical+important') {
    const important = cards.filter(
      (card) =>
        card.severity === 'important' &&
        card.status !== 'done' &&
        card.status !== 'cancelled',
    )
    if (important.length > 0) {
      warnings.push(
        `открыты важные находки (important): ${important.map((c) => c.id).join(', ')}`,
      )
    }
  }

  const review = cards.filter((card) => card.status === 'review')
  if (review.length > 0) {
    warnings.push(`карточки на ревью: ${review.map((c) => c.id).join(', ')}`)
  }

  const unreviewedDev = cards.filter(
    (card) =>
      card.inDev &&
      !card.inMain &&
      card.status === 'done' &&
      card.revertedAt === null &&
      !hasReviewVerdict(db, card.id) &&
      !hasReviewWaiver(db, card.id) &&
      !(
        packageRequired &&
        card.mergeCommit !== null &&
        packageCovers(db, card.mergeCommit)
      ),
  )
  if (unreviewedDev.length > 0) {
    warnings.push(
      `${packageRequired ? 'в dev без ревью, пакета и waiver' : 'в dev без ревью и waiver'}: ${unreviewedDev.map((c) => c.id).join(', ')}`,
    )
  }

  // План пропущен молча: done-карточка с обязательным ревью без шагов и без --no-plan.
  const noPlan = db
    .prepare(
      `select c.id from cards c
       where c.status = 'done' and c.review_required = 1 and c.plan_waived = 0
         and not exists (select 1 from steps s where s.card_id = c.id)
       order by c.id`,
    )
    .all() as Array<{ id: string }>
  if (noPlan.length > 0) {
    const shown = noPlan.slice(0, 5).map((row) => row.id).join(', ')
    const rest = noPlan.length > 5 ? ` и ещё ${noPlan.length - 5}` : ''
    warnings.push(`done без плана и без отметки --no-plan: ${noPlan.length} (${shown}${rest})`)
  }
}

function normalizePath(path: string): string {
  let resolved = path
  try {
    resolved = realpathSync.native(path)
  } catch {
    // путь может ещё не существовать — сравниваем как есть
  }
  return resolve(resolved).replace(/\\/g, '/').toLowerCase()
}
