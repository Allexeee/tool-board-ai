import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
  runGit,
  tagRelease,
} from './git.ts'
import { compareSemver, parseSemver } from './version.ts'
import { hasReviewVerdict, hasReviewWaiver, packageCovers } from './review.ts'
import type { Card } from './types.ts'

/** Версия проекта из package.json; если его нет — версия пакета board. */
function projectVersion(root: string): string {
  const local = join(root, 'package.json')
  const path = existsSync(local) ? local : new URL('../../package.json', import.meta.url)
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as { version?: string }
  return parsed.version?.trim() || '0.0.0'
}

/** Самый старший локальный тег vX.Y.Z. */
function latestReleaseTag(root: string): string | null {
  let tags: string[] = []
  try {
    tags = runGit(root, ['tag', '--list', 'v*'])
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((tag) => tag.replace(/^v/, ''))
      .filter((tag) => parseSemver(tag) !== null)
  } catch {
    return null
  }
  return tags.sort(compareSemver).at(-1) ?? null
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
 * Карточки без ревью: done в dev вне main, у которых нет вердикта или waiver,
 * либо нет покрытия пакетным проходом. Пакет обязателен всегда.
 */
function reviewGap(db: DatabaseSync, cards: Card[]): Card[] {
  return cards.filter((card) => {
    if (
      !card.inDev ||
      card.inMain ||
      card.status !== 'done' ||
      card.revertedAt !== null
    ) {
      return false
    }
    const reviewMissing = !hasReviewVerdict(db, card.id) && !hasReviewWaiver(db, card.id)
    const waived = hasReviewWaiver(db, card.id)
    const packageMissing =
      !waived && card.mergeCommit !== null && !packageCovers(db, card.mergeCommit)
    return reviewMissing || packageMissing
  })
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

  // Релиз блокируют только критичные находки: важные чинятся сразу, но не ждут.
  const severities = ['critical']
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

  const unreviewed = options.noReview ? [] : reviewGap(db, scoped)
  if (unreviewed.length > 0) {
    const detail = unreviewed.map((card) => card.id).join(', ')
    throw new UserError(2, `релиз заблокирован: нет ревью, пакета или waiver: ${detail}`)
  }

  const version = projectVersion(root)
  if (!parseSemver(version)) {
    throw new UserError(2, `версия ${version} не semver: нужен X.Y.Z`)
  }
  if (existsSync(join(root, 'package.json'))) {
    const last = latestReleaseTag(root)
    if (last !== null && compareSemver(version, last) <= 0) {
      throw new UserError(
        2,
        `версия ${version} не новее последнего тега v${last}: выполните board bump`,
      )
    }
  }

  const commit =
    selector === null
      ? releaseToMain(root)
      : releasePackageToMain(
          root,
          scoped.map((card) => card.mergeCommit!).filter((commit) => commit !== null),
        )
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
