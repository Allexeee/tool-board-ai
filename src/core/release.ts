import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { listCards } from './cards.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { refreshMergeState, releaseToMain } from './git.ts'
import type { Card } from './types.ts'

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
export function release(
  db: DatabaseSync,
  root: string,
  actor: string,
): { commit: string; cards: Card[] } {
  if (actor !== 'owner') throw new UserError(3, 'release — команда владельца')

  const all = listCards(db)

  const inDevNotDone = all.filter(
    (card) => card.inDev && card.status !== 'done' && card.revertedAt === null,
  )
  if (inDevNotDone.length > 0) {
    const detail = inDevNotDone.map((card) => `${card.id} (${card.status})`).join(', ')
    throw new UserError(2, `релиз заблокирован: в dev есть карточки не done: ${detail}`)
  }

  const critical = all.filter(
    (card) => card.severity === 'critical' && card.status !== 'done' && card.status !== 'cancelled',
  )
  if (critical.length > 0) {
    const detail = critical.map((card) => card.id).join(', ')
    throw new UserError(2, `релиз заблокирован: открыты критические находки: ${detail}`)
  }

  const commit = releaseToMain(root)

  return tx(db, () => {
    const cards: Card[] = []
    for (const card of all) {
      if (card.mergeCommit !== null) cards.push(refreshMergeState(db, root, card))
    }

    appendEvent(db, {
      type: 'release',
      actor,
      subject: 'board',
      note: commit,
      after: cards.map((card) => card.id),
    })

    return { commit, cards }
  })
}
