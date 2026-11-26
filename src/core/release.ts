import type { DatabaseSync } from 'node:sqlite'
import { readFileSync } from 'node:fs'
import { UserError } from '../cli/errors.ts'
import { listCards } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { getExecutor } from './executors.ts'
import {
  refreshMergeState,
  releasePackageToMain,
  releaseToMain,
  tagRelease,
} from './git.ts'
import { hasReviewVerdict, hasReviewWaiver, packageCovers } from './review.ts'
import { findingsScope, modelContext, packageReviewRequired } from './review-policy.ts'
import { readSettings } from './settings.ts'
import type { Card } from './types.ts'

/** Версия пакета board (package.json рядом с src), по ней ставится тег релиза. */
function boardVersion(): string {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  const parsed = JSON.parse(raw) as { version?: string }
  return parsed.version?.trim() || '0.0.0'
}

/**
 * Релиз §7.5: команда владельца. Мержит `dev` в `main` и обновляет `in_main`.
 *
 * Гейт:
 * 1. нет карточки с `in_dev=true`, статусом не `done` и без `reverted_at`
 *    (review, переоткрытие, in_progress — код уже в dev и не проверен);
 * 2. нет открытой карточки с `severity=critical` — критическая находка
 *    блокирует `main`, пока не `done`/`cancelled`.
 *
 * Карточки без merge-коммита (`needs_merge=false`) и отменённые
 * (`reverted_at` не null) гейт не трогают.
 */
export interface ReleaseOptions {
  /** Владелец явно отказался от ревью пакета; требуется reason. */
  noReview?: boolean
  reason?: string
  /** Релиз только карточек исполнителя (или навыка): остальное остаётся в dev. */
  package?: string | null
}

/** Карточки пакета: навык входит в навыки исполнителя; неизвестное имя — сам навык. */
function selectPackage(db: DatabaseSync, cards: Card[], selector: string): Card[] {
  const executor = getExecutor(db, selector)
  const skills = executor ? executor.skills : [selector]
  return cards.filter(
    (card) =>
      card.skill !== null &&
      skills.includes(card.skill) &&
      card.mergeCommit !== null &&
      card.revertedAt === null,
  )
}

/**
 * Карточки без ревью: done в dev вне main, у которых нет вердикта, waiver
 * и — когда профиль требует пакет — покрытия пакетным проходом.
 */
function reviewGap(
  db: DatabaseSync,
  cards: Card[],
  packageRequired: boolean,
): Card[] {
  return cards.filter(
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
}

export function release(
  db: DatabaseSync,
  root: string,
  actor: string,
  options: ReleaseOptions = {},
): { commit: string; cards: Card[]; reviewWaived: boolean } {
  if (actor !== 'owner') throw new UserError(3, 'release — команда владельца')
  const reason = options.reason?.trim() ?? ''
  if (options.noReview && reason === '') {
    throw new UserError(3, 'release --no-review требует --reason «почему без ревью»')
  }

  const all = listCards(db)

  // git — источник истины: перед гейтом пересчитываем кэш in_dev/in_main,
  // иначе ручной merge или рассинхрон пропустят непроверенный код в main.
  const fresh = all.map((card) =>
    card.mergeCommit === null ? card : refreshMergeState(db, root, card),
  )

  const selector = options.package?.trim() || null
  const scoped = selector === null ? fresh : selectPackage(db, fresh, selector)
  if (selector !== null && scoped.length === 0) {
    throw new UserError(1, `в пакете ${selector} нет карточек в dev вне main`)
  }

  const inDevNotDone = scoped.filter(
    (card) =>
      card.inDev &&
      card.status !== 'done' &&
      card.status !== 'acceptance' &&
      card.revertedAt === null,
  )
  if (inDevNotDone.length > 0) {
    const detail = inDevNotDone.map((card) => `${card.id} (${card.status})`).join(', ')
    throw new UserError(2, `релиз заблокирован: в dev есть карточки не done: ${detail}`)
  }

  const waitingAcceptance = scoped.filter(
    (card) => card.inDev && card.status === 'acceptance' && card.revertedAt === null,
  )
  if (waitingAcceptance.length > 0) {
    const detail = waitingAcceptance.map((card) => card.id).join(', ')
    throw new UserError(2, `релиз заблокирован: ждут приёмки владельцем: ${detail}`)
  }

  const settings = readSettings(root)
  const context = modelContext(process.env)
  const scope = findingsScope(settings, context)
  const severities = scope === 'critical+important' ? ['critical', 'important'] : ['critical']
  const selectedIds = new Set(scoped.map((card) => card.id))
  const blocking = fresh.filter(
    (card) =>
      card.severity !== null &&
      severities.includes(card.severity) &&
      card.status !== 'done' &&
      card.status !== 'cancelled' &&
      (selector === null ||
        selectedIds.has(card.id) ||
        (card.originCardId !== null && selectedIds.has(card.originCardId))),
  )
  if (blocking.length > 0) {
    const detail = blocking.map((card) => `${card.id} (${card.severity})`).join(', ')
    throw new UserError(2, `релиз заблокирован: открыты находки: ${detail}`)
  }

  const packageRequired = packageReviewRequired(settings, context)
  const unreviewed = options.noReview ? [] : reviewGap(db, scoped, packageRequired)
  if (unreviewed.length > 0) {
    const detail = unreviewed.map((card) => card.id).join(', ')
    const packageHint = packageRequired ? ' (нужен пакет: board review package)' : ''
    throw new UserError(2, `релиз заблокирован: нет ревью, пакета или waiver: ${detail}${packageHint}`)
  }

  const commit =
    selector === null
      ? releaseToMain(root)
      : releasePackageToMain(
          root,
          scoped.map((card) => card.mergeCommit!).filter((commit) => commit !== null),
        )
  const version = boardVersion()
  tagRelease(root, version, commit)

  return tx(db, () => {
    if (selector !== null) {
      const at = nowIso()
      for (const card of scoped) {
        db.prepare('update cards set main_commit = ?, updated_at = ? where id = ?').run(
          commit,
          at,
          card.id,
        )
      }
    }

    const cards: Card[] = []
    for (const card of fresh) {
      if (card.mergeCommit === null) continue
      const withMain =
        selector !== null && selectedIds.has(card.id) ? { ...card, mainCommit: commit } : card
      cards.push(refreshMergeState(db, root, withMain))
    }

    appendEvent(db, {
      type: 'release',
      actor,
      subject: 'board',
      note: commit,
      before: selector === null ? undefined : { package: selector },
      after: cards.filter((card) => card.inMain).map((card) => card.id),
    })

    if (options.noReview) {
      appendEvent(db, {
        type: 'release.review_waived',
        actor,
        subject: 'board',
        note: reason,
        after: { commit },
      })
    }

    return { commit, cards, reviewWaived: options.noReview === true }
  })
}
