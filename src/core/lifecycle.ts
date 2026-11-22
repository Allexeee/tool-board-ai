import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { createCard, editCard, getCard, type CardPatch } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { addDep, isSatisfied, listDeps, refreshReadiness } from './deps.ts'
import { comment, openQuestions } from './discussion.ts'
import { appendEvent } from './events.ts'
import { getExecutor } from './executors.ts'
import {
  currentBranch,
  ensureWorktree,
  isAncestor,
  mergeCommitFor,
  mergeToDev,
  outOfScope,
  revertMerge,
  runGit,
  startCardBranch,
  syncWithDev,
} from './git.ts'
import { insertIntoQueue, moveCard } from './queue.ts'
import { addRef, type RefKind } from './refs.ts'
import { revalidateDependents } from './review.ts'
import { getActiveRun, listRunCards, requireStandaloneCard, RUN_LEASE_MS, type Run } from './runs.ts'
import { assertSpecReview, type SpecReviewGate } from './spec-review.ts'
import type { Card, CardStatus } from './types.ts'

/** Навык owner означает owner-карточку: владелец закрывает её одной командой. */
const OWNER = 'owner'

/** Разбор держит lease 30 минут на карточку (§8.5). */
const SHAPING_LEASE_MS = 30 * 60 * 1000

/** Статусы, из которых блокировка осмысленна: разбор и выполнение. */
const BLOCKABLE_REQUEST: readonly CardStatus[] = ['new', 'shaping']
const BLOCKABLE_TASK: readonly CardStatus[] = ['booked', 'in_progress']

/** Переоткрытие возвращает карточку в работу из ревью или done. */
const REOPENABLE: readonly CardStatus[] = ['review', 'done']

/** Amend меняет уже утверждённый spec; в работе и ревью сначала block/reopen. */
const AMENDABLE: readonly CardStatus[] = ['approval', 'ready', 'waiting', 'blocked']

/** Отложить можно всё, что не в работе; работающую карточку сначала block. */
const DEFERRABLE: readonly CardStatus[] = [
  'new',
  'shaping',
  'approval',
  'ready',
  'waiting',
  'booked',
  'blocked',
]

function requireCard(db: DatabaseSync, id: string): Card {
  const card = getCard(db, id)
  if (!card) throw new UserError(3, `карточка ${id} не найдена`)
  return card
}

/**
 * Владелец может отложить и вернуть любую карточку. Агент — только карточку
 * своего навыка, которую не держит другой исполнитель.
 */
function assertCanDefer(db: DatabaseSync, card: Card, actor: string): void {
  if (actor === 'owner') return
  const executor = getExecutor(db, actor)
  if (!executor || card.skill === null || !executor.skills.includes(card.skill)) {
    throw new UserError(
      3,
      `навык карточки ${card.id} (${card.skill ?? '—'}) не подходит исполнителю ${actor}`,
    )
  }
  if (card.holder !== null && card.holder !== actor) {
    throw new UserError(3, `карточку ${card.id} держит другой исполнитель: ${card.holder}`)
  }
}

function requireActor(raw: string | undefined): string {
  const actor = raw?.trim()
  if (!actor) throw new UserError(3, 'нужен --as <исполнитель>')
  return actor
}

function requireReason(raw: string | undefined): string {
  const reason = raw?.trim()
  if (!reason) throw new UserError(3, 'нужна причина: --reason «...»')
  return reason
}

function requireSummary(raw: string | undefined): string {
  const summary = raw?.trim()
  if (!summary) throw new UserError(3, 'нужен отчёт: --summary «что сделано»')
  return summary
}

function assertScore(raw: number | null, label: string): void {
  if (raw === null || !Number.isInteger(raw) || raw < 0 || raw > 3) {
    throw new UserError(3, `${label} — целое число от 0 до 3`)
  }
}

/**
 * Начало разбора: `new` или истёкший `shaping`. Карточка переходит в `shaping`,
 * держатель получает lease на 30 минут, `shaped_at` фиксирует начало разбора.
 */
export function shapeCard(db: DatabaseSync, input: { id: string; actor: string }): Card {
  return tx(db, () => {
    let card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    const now = new Date()
    const at = now.toISOString()

    if (card.status === 'shaping' && card.leaseUntil !== null && card.leaseUntil < at) {
      db.prepare(
        "update cards set status = 'new', holder = null, lease_until = null, updated_at = ? where id = ?",
      ).run(at, card.id)
      const expired = getCard(db, card.id)!
      appendEvent(db, {
        type: 'card.lease_expired',
        actor: 'system',
        subject: card.id,
        before: card,
        after: expired,
        note: at,
      })
      card = expired
    }

    if (card.status !== 'new') {
      throw new UserError(3, `карточка ${card.id} в статусе ${card.status}: разбирается только new`)
    }

    const leaseUntil = new Date(now.getTime() + SHAPING_LEASE_MS).toISOString()

    db.prepare(
      `update cards set phase = 'request', status = 'shaping', holder = ?, lease_until = ?,
       shaped_at = ?, updated_at = ? where id = ?`,
    ).run(actor, leaseUntil, at, at, card.id)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.shaped',
      actor,
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}

/**
 * Отправка на утверждение: только держатель. Карточка становится задачей в
 * `approval`. Оценки и scope проверяются здесь, чтобы owner-инварианты и
 * обязательный scope для `needs_merge` не проскочили мимо.
 */
export function submitCard(
  db: DatabaseSync,
  input: { id: string; actor: string; requiredSpecReview?: SpecReviewGate },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (card.holder !== actor) {
      throw new UserError(
        3,
        `карточку ${card.id} может отправить только держатель (сейчас: ${card.holder ?? '—'})`,
      )
    }
    if (!card.skill) throw new UserError(3, 'у карточки нет навыка: укажите --skill')
    assertScore(card.importance, 'важность')
    assertScore(card.urgency, 'срочность')
    if (card.skill === OWNER && card.needsMerge) {
      throw new UserError(3, 'owner-карточка не мержится: needs_merge должен быть false')
    }
    if (card.needsMerge && card.scope.length === 0) {
      throw new UserError(3, 'для needs_merge=true нужен непустой scope')
    }
    if (card.body.trim() === '') {
      throw new UserError(3, 'у карточки нет spec: заполните body/spec')
    }
    if (card.acceptance.trim() === '') {
      throw new UserError(3, 'у карточки нет критериев приёмки: добавьте acceptance')
    }

    assertSpecReview(
      db,
      card,
      input.requiredSpecReview ?? { mode: 'none', reviewerModel: null },
    )

    const at = nowIso()
    db.prepare(
      `update cards set phase = 'task', status = 'approval', holder = null, lease_until = null,
       updated_at = ? where id = ?`,
    ).run(at, card.id)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.submitted',
      actor,
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}

/**
 * Утверждение владельца. Обычная карточка встаёт в очередь и пересчитывает
 * готовность; owner-карточка становится `ready` без очереди, мержа и ревью.
 */
export function approveCard(
  db: DatabaseSync,
  input: { id: string; actor: string; requiredSpecReview?: SpecReviewGate },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (actor !== OWNER) throw new UserError(3, 'утверждать карточку может только владелец')
    if (card.status !== 'approval') {
      throw new UserError(3, `карточка ${card.id} не в approval: ${card.status}`)
    }

    assertSpecReview(
      db,
      card,
      input.requiredSpecReview ?? { mode: 'none', reviewerModel: null },
    )

    const at = nowIso()
    if (card.skill === OWNER) {
      db.prepare(
        `update cards set status = 'ready', needs_merge = 0, review_required = 0, position = null,
         approved_at = ?, updated_at = ? where id = ?`,
      ).run(at, at, card.id)
    } else {
      db.prepare(
        `update cards set status = 'waiting', approved_at = ?, position = null, updated_at = ?
         where id = ?`,
      ).run(at, at, card.id)
      insertIntoQueue(db, card.id)
      refreshReadiness(db)
    }

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.approved',
      actor,
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}

/** Отказ владельца: карточка возвращается в `new`, содержимое сохраняется. */
export function rejectCard(
  db: DatabaseSync,
  input: { id: string; actor: string; reason: string },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (actor !== OWNER) throw new UserError(3, 'отклонять карточку может только владелец')
    if (card.status !== 'approval') {
      throw new UserError(3, `карточка ${card.id} не в approval: ${card.status}`)
    }
    const reason = requireReason(input.reason)

    const at = nowIso()
    db.prepare(
      `update cards set status = 'new', phase = 'request', holder = null, lease_until = null,
       approved_at = null, spec_rev = spec_rev + 1, updated_at = ? where id = ?`,
    ).run(at, card.id)

    // Причина отказа остаётся в обсуждении, как требует §10.1.
    comment(db, { cardId: card.id, author: actor, text: reason })

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.rejected',
      actor,
      subject: card.id,
      before: card,
      after: updated,
      note: reason,
    })
    return updated
  })
}

/**
 * Изменение утверждённого spec: версия растёт, review сбрасывается, карточка
 * возвращается в shaping. В работе/ревью сначала block/reopen.
 */
export function amendCard(
  db: DatabaseSync,
  input: { id: string; actor: string; reason: string },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    const reason = requireReason(input.reason)
    if (!AMENDABLE.includes(card.status)) {
      throw new UserError(
        3,
        `карточку ${card.id} нельзя изменить из ${card.status}: сначала block или reopen`,
      )
    }
    if (openQuestions(db, card.id).length > 0) {
      throw new UserError(
        3,
        `у карточки ${card.id} есть открытые вопросы: сначала ответьте на них`,
      )
    }

    const now = new Date()
    const at = now.toISOString()
    const leaseUntil = new Date(now.getTime() + SHAPING_LEASE_MS).toISOString()
    db.prepare(
      `update cards set phase = 'request', status = 'shaping', holder = ?, lease_until = ?,
       approved_at = null, spec_rev = spec_rev + 1, position = null, shaped_at = ?,
       updated_at = ? where id = ?`,
    ).run(actor, leaseUntil, at, at, card.id)
    // Возвращённый в разбор запрос снова стоит в очереди запросов.
    insertIntoQueue(db, card.id)

    comment(db, {
      cardId: card.id,
      author: actor,
      text: `spec amendment: ${reason}`,
    })

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.amended',
      actor,
      subject: card.id,
      before: card,
      after: updated,
      note: reason,
    })
    return updated
  })
}

/**
 * Владелец закрывает owner-карточку одной командой: `ready` → `done`.
 * Ни бронирования, ни git — owner-карточка не мержится.
 */
export function ownerDone(
  db: DatabaseSync,
  input: { id: string; actor: string; summary: string },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (actor !== OWNER) throw new UserError(3, 'owner-карточку закрывает только владелец')
    if (card.skill !== OWNER) {
      throw new UserError(3, `карточка ${card.id} — не owner-карточка: её закрывает finish`)
    }
    if (card.status !== 'ready') {
      throw new UserError(3, `карточка ${card.id} не в ready: ${card.status}`)
    }
    const summary = requireSummary(input.summary)

    const at = nowIso()
    db.prepare(
      `update cards set status = 'done', done_at = ?, summary = ?, updated_at = ? where id = ?`,
    ).run(at, summary, at, card.id)

    refreshReadiness(db)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.done',
      actor,
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}

/**
 * Блокировка: карточка ждёт владельца или решение. Фаза не меняется, поэтому
 * `resumeAfterAnswer` знает, куда вернуть карточку: `request` → `new`,
 * `task` → `waiting`/`ready`.
 */
export function blockCard(
  db: DatabaseSync,
  input: { id: string; actor: string; reason: string; note?: string },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    const reason = requireReason(input.reason)

    const blockable =
      card.phase === 'request'
        ? BLOCKABLE_REQUEST.includes(card.status)
        : BLOCKABLE_TASK.includes(card.status)
    if (!blockable) {
      throw new UserError(3, `карточку ${card.id} в статусе ${card.status} нельзя заблокировать`)
    }

    const note = input.note?.trim() || null
    const at = nowIso()
    db.prepare(
      `update cards set status = 'blocked', holder = null,
       run_id = case when phase = 'request' then run_id else null end,
       lease_until = null, updated_at = ? where id = ?`,
    ).run(at, card.id)

    // Карточка остаётся в забеге с пометкой blocked (§8.3): `run next` её
    // пропустит, `run end` снимет корректно.
    if (card.runId) {
      db.prepare("update run_cards set status = 'blocked' where run_id = ? and card_id = ?").run(
        card.runId,
        card.id,
      )
    }

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.blocked',
      actor,
      subject: card.id,
      before: card,
      after: updated,
      note: note ? `${reason} — ${note}` : reason,
    })
    return updated
  })
}

/**
 * Отложить карточку: `deferred` — состояние, а не приоритет. Снимает с забега,
 * очищает держателя, бронь и позицию в очереди; из now 1/2 и `--suggest` пропадает.
 * Работающую карточку сначала блокируют или сдают.
 */
export function deferCard(
  db: DatabaseSync,
  input: { id: string; actor: string; note?: string },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (!DEFERRABLE.includes(card.status)) {
      throw new UserError(
        3,
        `карточку ${card.id} в статусе ${card.status} нельзя отложить: сначала finish или block`,
      )
    }
    assertCanDefer(db, card, actor)

    if (card.runId) {
      db.prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?").run(
        card.runId,
        card.id,
      )
    }

    db.prepare(
      `update cards set status = 'deferred', holder = null, run_id = null, lease_until = null,
       position = null, updated_at = ? where id = ?`,
    ).run(nowIso(), card.id)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.deferred',
      actor,
      subject: card.id,
      before: card,
      after: updated,
      note: input.note?.trim() || null,
    })
    return updated
  })
}

/**
 * Вернуть отложенную карточку туда, где она была по смыслу: запрос — в `new`,
 * неутверждённая задача — в `approval` (гейт сохраняется), задача с открытым
 * вопросом — в `blocked`, иначе `ready`/`waiting` по зависимостям и в очередь.
 */
export function resumeCard(db: DatabaseSync, input: { id: string; actor: string }): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (card.status !== 'deferred') {
      throw new UserError(3, `карточка ${card.id} не отложена: ${card.status}`)
    }
    assertCanDefer(db, card, actor)

    const at = nowIso()
    let next: CardStatus
    if (card.phase === 'request') {
      next = 'new'
    } else if (card.approvedAt === null) {
      next = 'approval'
    } else if (openQuestions(db, card.id).length > 0) {
      next = 'blocked'
    } else {
      const ready = listDeps(db, card.id).every((dep) => isSatisfied(db, dep))
      next = ready ? 'ready' : 'waiting'
    }

    db.prepare('update cards set status = ?, updated_at = ? where id = ?').run(next, at, card.id)
    if (next === 'new' || next === 'ready' || next === 'waiting') insertIntoQueue(db, card.id)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.resumed',
      actor,
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}

/**
 * Отмена: держатель — только свою, владелец — любую. Причина обязательна.
 * `waiveDeps` закрывает карточку для зависимых. Если передан `root` и у карточки
 * есть `merge_commit` в dev, отмена создаёт revert-коммит (§7.8): конфликт
 * останавливает команду и оставляет карточку в прежнем статусе.
 */
export function cancelCard(
  db: DatabaseSync,
  input: { id: string; actor: string; reason: string; waiveDeps?: boolean; root?: string },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    const reason = requireReason(input.reason)

    if (actor !== OWNER && actor !== card.holder) {
      throw new UserError(
        3,
        `отменить карточку ${card.id} может владелец или держатель (сейчас: ${card.holder ?? '—'})`,
      )
    }
    if (card.status === 'cancelled') {
      throw new UserError(3, `карточка ${card.id} уже отменена`)
    }

    // Revert до записи статуса: конфликт откатывает транзакцию, карточка не меняется.
    let revertedAt: string | null = null
    let revertCommit: string | null = null
    if (input.root && card.mergeCommit && card.inDev) {
      revertCommit = revertMerge(input.root, card.mergeCommit)
      revertedAt = nowIso()
    }

    if (card.runId) {
      db.prepare("update run_cards set status = 'dropped' where run_id = ? and card_id = ?").run(
        card.runId,
        card.id,
      )
    }

    const at = nowIso()
    db.prepare(
      `update cards set status = 'cancelled', cancel_reason = ?, waive_deps = ?,
       reverted_at = ?, revert_commit = ?, holder = null, run_id = null, lease_until = null,
       updated_at = ? where id = ?`,
    ).run(reason, input.waiveDeps === true ? 1 : 0, revertedAt, revertCommit, at, card.id)

    refreshReadiness(db)
    if (!input.waiveDeps) revalidateDependents(db, card.id)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.cancelled',
      actor,
      subject: card.id,
      before: card,
      after: updated,
      note: reason,
    })
    return updated
  })
}

/**
 * Переоткрытие из `review`/`done`: статус `ready` (или `waiting`, если
 * зависимости не закрыты), попытка растёт, `reverted_at` очищается, прежний
 * держатель запоминается в `previous_holder`, карточка встаёт в начало очереди.
 */
export function reopenCard(
  db: DatabaseSync,
  input: { id: string; actor: string; reason: string },
): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    const reason = requireReason(input.reason)
    if (actor !== OWNER) {
      throw new UserError(3, 'переоткрывать карточку может только владелец')
    }
    if (!REOPENABLE.includes(card.status)) {
      throw new UserError(3, `карточку ${card.id} в статусе ${card.status} нельзя переоткрыть`)
    }

    const ready = listDeps(db, card.id).every((dep) => isSatisfied(db, dep))
    const status = ready ? 'ready' : 'waiting'
    const at = nowIso()

    db.prepare(
      `update cards set status = ?, attempt = attempt + 1, reverted_at = null,
       previous_holder = ?, holder = null, run_id = null, lease_until = null,
       updated_at = ? where id = ?`,
    ).run(status, card.holder, at, card.id)

    // Owner-карточка не встаёт в очередь: её закрывает и переоткрывает владелец.
    if (card.skill !== OWNER) {
      if (getCard(db, card.id)!.position === null) insertIntoQueue(db, card.id)
      moveCard(db, card.id, { top: true })
    }

    refreshReadiness(db)
    revalidateDependents(db, card.id)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.reopened',
      actor,
      subject: card.id,
      before: card,
      after: updated,
      note: reason,
    })
    return updated
  })
}

/**
 * После ответа на последний открытый вопрос заблокированная карточка
 * возвращается в работу: `request` → `new`, `task` → `waiting`/`ready`.
 * Возвращает карточку или null, если резюмировать нечего.
 */
export function resumeAfterAnswer(db: DatabaseSync, cardId: string, actor: string): Card | null {
  return tx(db, () => {
    const card = requireCard(db, cardId)
    if (card.status !== 'blocked') return null
    const actorName = requireActor(actor)
    if (openQuestions(db, cardId).length > 0) return null

    const ready = listDeps(db, cardId).every((dep) => isSatisfied(db, dep))
    const status = card.phase === 'request' ? 'new' : ready ? 'ready' : 'waiting'
    const at = nowIso()

    db.prepare('update cards set status = ?, updated_at = ? where id = ?').run(status, at, cardId)

    const updated = getCard(db, cardId)!
    if (updated.phase === 'task' && updated.position === null) insertIntoQueue(db, cardId)
    appendEvent(db, {
      type: 'card.resumed',
      actor: actorName,
      subject: cardId,
      before: card,
      after: updated,
      note: 'вопросы закрыты',
    })
    return updated
  })
}

/** JSON-схема пакетного разбора §10.1: поля карточки, шаги, ссылки и новые карточки. */
export interface ShapeFileNewCard {
  key: string
  group: string
  title: string
  skill: string
  spec?: string
  body?: string
  acceptance?: string[]
  needs_merge?: boolean
  review_required?: boolean
  scope?: string[]
  tags?: string[]
}

export interface ShapeFile {
  spec?: string
  /** Старый алиас spec. */
  body?: string
  acceptance?: string[]
  skill?: string
  importance?: number
  urgency?: number
  needs_merge?: boolean
  review_required?: boolean
  scope?: string[]
  tags?: string[]
  refs?: Array<{ kind: string; value: string; title?: string }>
  deps?: string[]
  new_cards?: ShapeFileNewCard[]
  new_deps?: Array<[string, string]>
}

/**
 * Пакетный разбор: применяет поля карточки, шаги, ссылки, зависимости и создаёт
 * новые карточки-запросы одной транзакцией. Любая ошибка откатывает всё.
 */
export function applyShapeFile(
  db: DatabaseSync,
  input: { id: string; actor: string; file: ShapeFile },
): { card: Card; newCards: Card[] } {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (card.status !== 'shaping') {
      throw new UserError(3, `карточка ${card.id} не в shaping: сначала board card shape`)
    }
    if (card.holder !== actor) {
      throw new UserError(
        3,
        `карточку ${card.id} может разбирать только держатель (сейчас: ${card.holder ?? '—'})`,
      )
    }

    const file = input.file
    if (typeof file !== 'object' || file === null || Array.isArray(file)) {
      throw new UserError(3, 'файл разбора — объект JSON')
    }
    if ('steps' in file) {
      throw new UserError(3, 'steps пишутся при take, не при shape')
    }

    // Поля карточки — через editCard: он переиспользует валидацию оценок,
    // owner-инвариантов и неизменяемости навыка.
    const patch: CardPatch = {}
    const spec = file.spec ?? file.body
    if (spec !== undefined) patch.body = spec
    if (file.acceptance !== undefined) patch.acceptance = file.acceptance
    if (file.skill !== undefined) patch.skill = file.skill
    if (file.importance !== undefined) patch.importance = file.importance
    if (file.urgency !== undefined) patch.urgency = file.urgency
    if (file.needs_merge !== undefined) patch.needsMerge = file.needs_merge
    if (file.review_required !== undefined) patch.reviewRequired = file.review_required
    if (file.scope !== undefined) patch.scope = file.scope
    if (file.tags !== undefined) patch.tags = file.tags
    if (Object.keys(patch).length > 0) editCard(db, { id: card.id, actor, patch })
    for (const ref of file.refs ?? []) {
      addRef(db, {
        cardId: card.id,
        kind: ref.kind as RefKind,
        value: ref.value,
        title: ref.title,
        actor,
      })
    }
    for (const dep of file.deps ?? []) addDep(db, card.id, dep, actor)

    // Новые карточки — отдельные запросы; key → выданный ID.
    const newIds = new Map<string, string>()
    const newCards: Card[] = []
    for (const item of file.new_cards ?? []) {
      const key = item.key?.trim()
      if (!key) throw new UserError(3, 'у новой карточки нет key')
      if (!item.group) throw new UserError(3, 'у новой карточки нет группы')
      const created = createCard(db, {
        group: item.group,
        title: item.title,
        body: item.spec ?? item.body,
        acceptance: item.acceptance,
        skill: item.skill,
        author: actor,
        tags: item.tags,
      })
      const createdPatch: CardPatch = {}
      if (item.needs_merge !== undefined) createdPatch.needsMerge = item.needs_merge
      if (item.review_required !== undefined) createdPatch.reviewRequired = item.review_required
      if (item.scope !== undefined) createdPatch.scope = item.scope
      if (Object.keys(createdPatch).length > 0) {
        editCard(db, { id: created.id, actor, patch: createdPatch })
      }
      insertIntoQueue(db, created.id)
      newIds.set(key, created.id)
      newCards.push(getCard(db, created.id)!)
    }

    // new_deps: пары [от, к] — локальные key новых карточек и ID карточек.
    const resolve = (ref: string): string => newIds.get(ref) ?? ref
    for (const [from, to] of file.new_deps ?? []) {
      addDep(db, resolve(from), resolve(to), actor)
    }

    return { card: getCard(db, card.id)!, newCards }
  })
}

/**
 * Взятие карточки в работу §8.3: `booked` → `in_progress`. Держатель, закрытые
 * зависимости и активный забег обязательны. Для `needs_merge=true` создаётся
 * worktree и ветка карточки от свежего `dev`; грязный worktree или ошибка
 * создания откатывают переход. Lease забега продлевается на два часа.
 */
export function takeCard(db: DatabaseSync, input: { id: string; actor: string; root: string }): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)

    if (card.phase === 'request') return takeRequest(db, card, actor, input.root)

    // Одиночная карточка: без брони и забега, если она готова к работе.
    if (card.status === 'ready' || card.status === 'waiting') {
      const standalone = requireStandaloneCard(db, actor, card.id)
      return startWork(db, standalone, actor, input.root, null)
    }

    if (card.status !== 'booked') {
      throw new UserError(3, `карточка ${card.id} не забронирована: ${card.status}`)
    }
    if (card.holder !== actor) {
      throw new UserError(
        3,
        `карточку ${card.id} может взять только держатель (сейчас: ${card.holder ?? '—'})`,
      )
    }
    const unmet = listDeps(db, card.id).filter((dep) => !isSatisfied(db, dep))
    if (unmet.length > 0) {
      throw new UserError(3, `зависимость ${unmet.join(', ')} карточки ${card.id} не закрыта`)
    }
    const run = getActiveRun(db, actor)
    if (!run || run.id !== card.runId) {
      throw new UserError(3, `у исполнителя ${actor} нет активного забега с карточкой ${card.id}`)
    }

    return startWork(db, card, actor, input.root, run)
  })
}

/**
 * Запрос в забеге: первый take разбирает, второй — продвигает в работу.
 * Approve владельца не требуется: spec показывается, забег можно остановить.
 */
function takeRequest(
  db: DatabaseSync,
  card: Card,
  actor: string,
  root: string,
): Card {
  const run = getActiveRun(db, actor)
  if (!run || run.id !== card.runId) {
    throw new UserError(3, `у исполнителя ${actor} нет активного забега с запросом ${card.id}`)
  }
  const row = listRunCards(db, run.id).find((item) => item.cardId === card.id)
  if (!row || (row.status !== 'planned' && row.status !== 'blocked')) {
    throw new UserError(3, `запрос ${card.id} не в забеге ${run.id}`)
  }
  if (card.status === 'blocked' || openQuestions(db, card.id).length > 0) {
    throw new UserError(3, `запрос ${card.id} ждёт ответа владельца`)
  }

  if (card.status === 'new') {
    return shapeCard(db, { id: card.id, actor })
  }
  if (card.status !== 'shaping' || card.holder !== actor) {
    throw new UserError(3, `запрос ${card.id} не в разборе у ${actor}: ${card.status}`)
  }
  if (card.body.trim() === '') throw new UserError(3, `у запроса ${card.id} нет spec`)
  if (card.acceptance.trim() === '') {
    throw new UserError(3, `у запроса ${card.id} нет критериев приёмки`)
  }
  if (!card.skill) throw new UserError(3, `у запроса ${card.id} нет навыка`)
  assertScore(card.importance, 'важность')
  assertScore(card.urgency, 'срочность')
  if (card.needsMerge && card.scope.length === 0) {
    throw new UserError(3, `для needs_merge=true нужен непустой scope`)
  }

  const promoted = startWork(db, card, actor, root, run)
  // Правило забега — авторизация вместо approve: фиксируем её, чтобы resume
  // вернул карточку в работу, а не в approval.
  if (promoted.approvedAt === null || promoted.position !== null) {
    db.prepare(
      'update cards set approved_at = coalesce(approved_at, ?), position = null where id = ?',
    ).run(nowIso(), card.id)
  }
  const authorized = getCard(db, card.id)!
  appendEvent(db, {
    type: 'card.promoted',
    actor,
    subject: card.id,
    before: card,
    after: authorized,
    note: `забег ${run.id}: approve пропущен по правилу запроса в забеге`,
  })
  return authorized
}

function startWork(
  db: DatabaseSync,
  card: Card,
  actor: string,
  root: string,
  run: Run | null,
): Card {
  // Одна карточка в работе на держателя: worktree один, две ветки не живут.
  if (run) {
    const otherInProgress = listRunCards(db, run.id).some(
      (row) => row.status === 'in_progress' && row.cardId !== card.id,
    )
    if (otherInProgress) {
      throw new UserError(
        3,
        `в забеге ${run.id} уже есть карточка в работе: сначала finish или block`,
      )
    }
  }
  const busy = db
    .prepare("select id from cards where holder = ? and status = 'in_progress' and id != ?")
    .get(actor, card.id) as { id: string } | undefined
  if (busy) {
    throw new UserError(
      3,
      `у исполнителя ${actor} уже есть карточка в работе: ${busy.id} — сначала finish или block`,
    )
  }

  let branch: string | null = card.branch
  if (card.needsMerge) {
    branch = startCardBranch(root, actor, card).branch
  }

  const at = nowIso()
  const leaseUntil = new Date(Date.now() + RUN_LEASE_MS).toISOString()
  db.prepare(
    `update cards set phase = 'task', status = 'in_progress', holder = ?, branch = ?, lease_until = ?,
     updated_at = ? where id = ?`,
  ).run(actor, branch, leaseUntil, at, card.id)
  if (run) {
    db.prepare('update runs set lease_until = ? where id = ?').run(leaseUntil, run.id)
    db.prepare("update run_cards set status = 'in_progress' where run_id = ? and card_id = ?").run(
      run.id,
      card.id,
    )
  }

  const updated = getCard(db, card.id)!
  appendEvent(db, {
    type: 'card.taken',
    actor,
    subject: card.id,
    before: card,
    after: updated,
  })
  return updated
}

export interface FinishInput {
  id: string
  actor: string
  summary: string
  root: string
  noMerge?: boolean
  mergeCommit?: string
  forceReview?: boolean
}

/**
 * Сдача карточки §7.2: `in_progress` → `review`/`done`. Для `needs_merge=true`
 * worktree должен быть чистым, затем `syncWithDev`, проверка `scope` и мерж в
 * `dev` без fast-forward; конфликт останавливает команду. `--no-merge` не
 * мержит, но требует чистый worktree, scope и merge-коммит в `dev`.
 */
export function finishCard(db: DatabaseSync, input: FinishInput): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    const summary = requireSummary(input.summary)

    if (card.holder !== actor) {
      throw new UserError(
        3,
        `карточку ${card.id} может закрыть только держатель (сейчас: ${card.holder ?? '—'})`,
      )
    }
    if (card.status !== 'in_progress') {
      throw new UserError(3, `карточка ${card.id} не в работе: ${card.status}`)
    }
    // Переоткрытая зависимость не даёт сдать работу, пока не вернётся в review/done.
    const unmet = listDeps(db, card.id).filter((dep) => !isSatisfied(db, dep))
    if (unmet.length > 0) {
      throw new UserError(
        3,
        `зависимость ${unmet.join(', ')} карточки ${card.id} не закрыта: finish невозможен`,
      )
    }
    if (input.noMerge && !card.needsMerge) {
      throw new UserError(3, `--no-merge применим только к needs_merge=true (карточка ${card.id})`)
    }

    let mergeCommit: string | null = null
    let inDev = false

    if (card.needsMerge) {
      if (!card.branch) {
        throw new UserError(3, `у карточки ${card.id} нет ветки: сначала board take`)
      }
      const worktree = ensureWorktree(input.root, actor)
      const checkedOut = currentBranch(worktree)
      if (checkedOut !== card.branch) {
        throw new UserError(
          3,
          `рабочее дерево ${worktree} на ветке ${checkedOut ?? 'без ветки'}, а карточка ${card.id} — на ${card.branch}: сначала board take`,
        )
      }
      if (runGit(worktree, ['status', '--porcelain']) !== '') {
        throw new UserError(
          3,
          `рабочее дерево ${worktree} грязное: сначала закоммитьте или откатите изменения`,
        )
      }

      if (input.noMerge) {
        const out = outOfScope(input.root, card.branch, card.scope)
        if (out.length > 0) {
          throw new UserError(3, `файлы вне scope карточки ${card.id}: ${out.join(', ')}`)
        }
        mergeCommit = input.mergeCommit ?? mergeCommitFor(input.root, card.branch)
        if (!mergeCommit) {
          throw new UserError(3, `merge-коммит ветки ${card.branch} не найден в dev`)
        }
        inDev = isAncestor(input.root, mergeCommit, 'dev')
        if (!inDev) {
          throw new UserError(3, `коммит ${mergeCommit} не является предком dev`)
        }
      } else {
        syncWithDev(input.root, worktree, card.branch)
        const out = outOfScope(input.root, card.branch, card.scope)
        if (out.length > 0) {
          throw new UserError(3, `файлы вне scope карточки ${card.id}: ${out.join(', ')}`)
        }
        mergeCommit = mergeToDev(input.root, card.branch, `merge ${card.id}: ${summary}`)
        inDev = isAncestor(input.root, mergeCommit, 'dev')
      }
    }

    const status = card.reviewRequired || input.forceReview === true ? 'review' : 'done'
    const at = nowIso()
    db.prepare(
      `update cards set status = ?, summary = ?, done_at = ?, merge_commit = ?, in_dev = ?, in_main = 0,
       updated_at = ? where id = ?`,
    ).run(status, summary, status === 'done' ? at : null, mergeCommit, inDev ? 1 : 0, at, card.id)

    if (card.runId) {
      db.prepare('update run_cards set status = ? where run_id = ? and card_id = ?').run(
        status,
        card.runId,
        card.id,
      )
    }

    refreshReadiness(db)

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.finished',
      actor,
      subject: card.id,
      before: card,
      after: updated,
      note: summary,
    })
    return updated
  })
}

/**
 * Продление lease §8.5: для `shaping` — 30 минут, для `booked`/`in_progress` —
 * два часа (вместе с забегом). Остальные статусы продлить нельзя.
 */
export function touchCard(db: DatabaseSync, input: { id: string; actor: string }): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)

    if (
      card.status !== 'shaping' &&
      card.status !== 'booked' &&
      card.status !== 'in_progress'
    ) {
      throw new UserError(
        3,
        `карточку ${card.id} в статусе ${card.status} нельзя продлить: touch применим только к shaping, booked и in_progress`,
      )
    }
    if (card.holder !== actor) {
      throw new UserError(
        3,
        `карточку ${card.id} может продлить только держатель (сейчас: ${card.holder ?? '—'})`,
      )
    }

    const leaseMs = card.status === 'shaping' ? SHAPING_LEASE_MS : RUN_LEASE_MS
    const leaseUntil = new Date(Date.now() + leaseMs).toISOString()
    db.prepare('update cards set lease_until = ?, updated_at = ? where id = ?').run(
      leaseUntil,
      nowIso(),
      card.id,
    )
    if (card.runId) {
      db.prepare('update runs set lease_until = ? where id = ?').run(leaseUntil, card.runId)
    }

    const updated = getCard(db, card.id)!
    appendEvent(db, {
      type: 'card.touched',
      actor,
      subject: card.id,
      before: card,
      after: updated,
    })
    return updated
  })
}
