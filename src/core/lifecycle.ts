import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { createCard, editCard, getCard, type CardPatch } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { addDep, isSatisfied, listDeps, refreshReadiness } from './deps.ts'
import { comment, openQuestions } from './discussion.ts'
import { appendEvent } from './events.ts'
import { insertIntoQueue, moveCard } from './queue.ts'
import { addRef, type RefKind } from './refs.ts'
import { addStep } from './steps.ts'
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

function requireCard(db: DatabaseSync, id: string): Card {
  const card = getCard(db, id)
  if (!card) throw new UserError(3, `карточка ${id} не найдена`)
  return card
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
 * Начало разбора: только `new`. Карточка переходит в `shaping`, держатель
 * получает lease на 30 минут, `shaped_at` фиксирует начало разбора.
 */
export function shapeCard(db: DatabaseSync, input: { id: string; actor: string }): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (card.status !== 'new') {
      throw new UserError(3, `карточка ${card.id} в статусе ${card.status}: разбирается только new`)
    }

    const now = new Date()
    const at = now.toISOString()
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
export function submitCard(db: DatabaseSync, input: { id: string; actor: string }): Card {
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
export function approveCard(db: DatabaseSync, input: { id: string; actor: string }): Card {
  return tx(db, () => {
    const card = requireCard(db, input.id)
    const actor = requireActor(input.actor)
    if (actor !== OWNER) throw new UserError(3, 'утверждать карточку может только владелец')
    if (card.status !== 'approval') {
      throw new UserError(3, `карточка ${card.id} не в approval: ${card.status}`)
    }

    const at = nowIso()
    if (card.skill === OWNER) {
      db.prepare(
        `update cards set status = 'ready', needs_merge = 0, review_required = 0, position = null,
         approved_at = ?, updated_at = ? where id = ?`,
      ).run(at, at, card.id)
    } else {
      db.prepare(
        `update cards set status = 'waiting', approved_at = ?, updated_at = ? where id = ?`,
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
       updated_at = ? where id = ?`,
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
      `update cards set status = 'blocked', holder = null, run_id = null, lease_until = null,
       updated_at = ? where id = ?`,
    ).run(at, card.id)

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
 * Отмена: держатель — только свою, владелец — любую. Причина обязательна.
 * `waiveDeps` закрывает карточку для зависимых. Git-revert появится в задаче 10,
 * когда передан `root`.
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

    const at = nowIso()
    db.prepare(
      `update cards set status = 'cancelled', cancel_reason = ?, waive_deps = ?,
       holder = null, run_id = null, lease_until = null, updated_at = ? where id = ?`,
    ).run(reason, input.waiveDeps === true ? 1 : 0, at, card.id)

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
    if (!REOPENABLE.includes(card.status)) {
      throw new UserError(3, `карточку ${card.id} в статусе ${card.status} нельзя переоткрыть`)
    }

    const ready = listDeps(db, card.id).every((dep) => isSatisfied(db, dep))
    const status = ready ? 'ready' : 'waiting'
    const at = nowIso()

    db.prepare(
      `update cards set status = ?, attempt = attempt + 1, reverted_at = null,
       previous_holder = ?, holder = null, updated_at = ? where id = ?`,
    ).run(status, card.holder, at, card.id)

    // Owner-карточка не встаёт в очередь: её закрывает и переоткрывает владелец.
    if (card.skill !== OWNER) {
      if (getCard(db, card.id)!.position === null) insertIntoQueue(db, card.id)
      moveCard(db, card.id, { top: true })
    }

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
  body?: string
  needs_merge?: boolean
  review_required?: boolean
  scope?: string[]
}

export interface ShapeFile {
  body?: string
  skill?: string
  importance?: number
  urgency?: number
  needs_merge?: boolean
  review_required?: boolean
  scope?: string[]
  steps?: string[]
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

    // Поля карточки — через editCard: он переиспользует валидацию оценок,
    // owner-инвариантов и неизменяемости навыка.
    const patch: CardPatch = {}
    if (file.body !== undefined) patch.body = file.body
    if (file.skill !== undefined) patch.skill = file.skill
    if (file.importance !== undefined) patch.importance = file.importance
    if (file.urgency !== undefined) patch.urgency = file.urgency
    if (file.needs_merge !== undefined) patch.needsMerge = file.needs_merge
    if (file.review_required !== undefined) patch.reviewRequired = file.review_required
    if (file.scope !== undefined) patch.scope = file.scope
    if (Object.keys(patch).length > 0) editCard(db, { id: card.id, actor, patch })

    for (const text of file.steps ?? []) addStep(db, { cardId: card.id, text, actor })
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
        body: item.body,
        skill: item.skill,
        author: actor,
      })
      const createdPatch: CardPatch = {}
      if (item.needs_merge !== undefined) createdPatch.needsMerge = item.needs_merge
      if (item.review_required !== undefined) createdPatch.reviewRequired = item.review_required
      if (item.scope !== undefined) createdPatch.scope = item.scope
      if (Object.keys(createdPatch).length > 0) {
        editCard(db, { id: created.id, actor, patch: createdPatch })
      }
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
