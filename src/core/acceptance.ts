import type { DatabaseSync } from 'node:sqlite'
import type { Card } from './types.ts'
import { nowIso } from './clock.ts'
import { runGit } from './git.ts'
import { scopeAllows } from './scope.ts'
import type {
  AcceptanceConditions,
  AcceptanceRule,
  AcceptanceSettings,
  BoardSettings,
} from './settings.ts'

export interface AcceptanceDecision {
  required: boolean
  matched: string[]
  excluded: string[]
}

function hasAny(conditions: AcceptanceConditions | undefined): boolean {
  if (!conditions) return false
  return (
    (conditions.groups?.length ?? 0) > 0 ||
    (conditions.tags?.length ?? 0) > 0 ||
    (conditions.skills?.length ?? 0) > 0 ||
    (conditions.paths?.length ?? 0) > 0
  )
}

function pathsMatch(card: Card, paths: string[], patterns: string[]): boolean {
  const candidates = paths.length > 0 ? paths : card.scope
  return candidates.some((path) => scopeAllows(path, patterns))
}

/** Условие совпадает, если совпало любое из его измерений. */
export function conditionsMatch(
  conditions: AcceptanceConditions | undefined,
  card: Card,
  paths: string[] = [],
): boolean {
  if (!hasAny(conditions)) return false
  if (conditions!.groups?.includes(card.group)) return true
  if (card.skill !== null && conditions!.skills?.includes(card.skill)) return true
  if (conditions!.tags?.some((tag) => card.tags.includes(tag))) return true
  if (conditions!.paths && pathsMatch(card, paths, conditions!.paths)) return true
  return false
}

function ruleMatches(rule: AcceptanceRule, card: Card, paths: string[]): boolean {
  if (!conditionsMatch(rule.include, card, paths)) return false
  if (conditionsMatch(rule.exclude, card, paths)) return false
  return true
}

/** Решение по правилам: ручной флаг сюда не входит. */
export function evaluateAcceptance(
  settings: BoardSettings,
  card: Card,
  paths: string[] = [],
): AcceptanceDecision {
  if (card.skill === 'owner') return { required: false, matched: [], excluded: [] }

  const acceptance: AcceptanceSettings = settings.acceptance ?? { rules: [] }
  if (conditionsMatch(acceptance.exclude, card, paths)) {
    return { required: false, matched: [], excluded: ['общее исключение'] }
  }

  const matched = acceptance.rules
    .filter((rule) => ruleMatches(rule, card, paths))
    .map((rule) => rule.name)
  return { required: matched.length > 0, matched, excluded: [] }
}

/** Фактические файлы карточки из merge-коммита; без него — заявленный scope. */
export function acceptancePaths(root: string, card: Card): string[] {
  if (card.mergeCommit === null) return card.scope
  try {
    return runGit(root, [
      'diff',
      '--name-only',
      `${card.mergeCommit}^1`,
      card.mergeCommit,
    ])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  } catch {
    return card.scope
  }
}

/**
 * Пересчитывает auto-флаг по правилам. Ручной выбор не трогаем.
 * Возвращает карточку с актуальным ownerAcceptance.
 */
export function recalculateAcceptance(
  db: DatabaseSync,
  root: string,
  card: Card,
  settings: BoardSettings,
  paths?: string[],
): Card {
  if (card.ownerAcceptanceManual) return card
  if (card.status === 'done' || card.status === 'cancelled') return card
  const decision = evaluateAcceptance(
    settings,
    card,
    paths ?? acceptancePaths(root, card),
  )
  const next = decision.required
  if (card.ownerAcceptance === next) return card
  db.prepare('update cards set owner_acceptance = ?, updated_at = ? where id = ?').run(
    next ? 1 : 0,
    nowIso(),
    card.id,
  )
  return { ...card, ownerAcceptance: next }
}

/** Для check: какие правила сработали и почему исключено. */
export function explainAcceptance(
  db: DatabaseSync,
  root: string,
  card: Card,
  settings: BoardSettings,
): AcceptanceDecision & { manual: boolean } {
  const paths = acceptancePaths(root, card)
  const decision = evaluateAcceptance(settings, card, paths)
  const manual = card.ownerAcceptanceManual
  if (manual) {
    return {
      ...decision,
      required: card.ownerAcceptance,
      matched: decision.matched.length > 0 ? decision.matched : ['ручной флаг'],
      manual,
    }
  }
  return { ...decision, manual }
}
