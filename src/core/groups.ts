import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getCard, listCards } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

const PREFIX = /^[A-Z0-9]{1,8}$/

/** Префикс группы — 1–8 символов A-Z0-9; регистр не важен. */
export function normalizeGroupPrefix(raw: string): string {
  const prefix = raw.trim().toUpperCase()
  if (!PREFIX.test(prefix)) {
    throw new UserError(3, `недопустимый префикс группы «${raw}»: нужно 1–8 символов A-Z0-9`)
  }
  return prefix
}

export interface CardGroup {
  prefix: string
  name: string | null
  count: number
}

/** Области проекта: префикс, название и число карточек. */
export function listGroups(db: DatabaseSync): CardGroup[] {
  const rows = db
    .prepare(
      `select g.prefix, g.name,
              (select count(*) from cards c where c.group_prefix = g.prefix) as count
       from groups g order by g.prefix`,
    )
    .all() as Array<{ prefix: string; name: string | null; count: number }>
  return rows.map((row) => ({ prefix: row.prefix, name: row.name, count: row.count }))
}

export function groupExists(db: DatabaseSync, prefix: string): boolean {
  const row = db.prepare('select 1 as found from groups where prefix = ?').get(prefix)
  return row !== undefined
}

/** Область проекта без карточки: префикс, название, событие в журнал. */
export function addGroup(
  db: DatabaseSync,
  input: { prefix: string; name?: string | null; actor: string },
): CardGroup {
  return tx(db, () => {
    const prefix = normalizeGroupPrefix(input.prefix)
    if (groupExists(db, prefix)) throw new UserError(3, `группа ${prefix} уже есть`)
    const name = input.name?.trim() ? input.name.trim() : null
    db.prepare('insert into groups (prefix, name, created_at) values (?, ?, ?)').run(
      prefix,
      name,
      nowIso(),
    )
    appendEvent(db, {
      type: 'group.added',
      actor: input.actor,
      subject: prefix,
      after: { prefix, name },
    })
    return { prefix, name, count: 0 }
  })
}

export interface GroupRenameInput {
  old: string
  next: string
  merge?: boolean
  name?: string | null
  actor: string
  dryRun?: boolean
}

export interface GroupRenameResult {
  from: string
  to: string
  cards: Array<{ from: string; to: string }>
  created: boolean
  dryRun: boolean
}

const ACTIVE_FOR_REKEY = ['in_progress', 'booked', 'shaping']

/**
 * Переименование префикса и rekey карточек одной транзакцией.
 * Без --merge в существующую группу не переносим; при коллизии номера
 * выдаются из next_seq целевой группы.
 */
export function renameGroup(db: DatabaseSync, input: GroupRenameInput): GroupRenameResult {
  const from = normalizeGroupPrefix(input.old)
  const to = normalizeGroupPrefix(input.next)
  if (from === to) throw new UserError(3, 'старый и новый префикс совпадают')
  if (!groupExists(db, from)) throw new UserError(3, `группы ${from} нет`)
  const exists = groupExists(db, to)
  if (exists && input.merge !== true) {
    throw new UserError(3, `группа ${to} уже есть: для слияния нужен --merge`)
  }

  const cards = listCards(db, { group: from })
  const active = cards.filter((card) => ACTIVE_FOR_REKEY.includes(card.status))
  if (active.length > 0) {
    throw new UserError(
      2,
      `нельзя переименовать: карточки в работе ${active.map((card) => card.id).join(', ')} — сначала finish или block`,
    )
  }

  const nextRow = exists
    ? (db.prepare('select next_seq from groups where prefix = ?').get(to) as { next_seq: number })
    : null
  let nextSeq = nextRow?.next_seq ?? 1
  const used = new Set<string>()
  const mapping: Array<{ cardId: string; from: string; to: string; seq: number }> = []

  for (const card of [...cards].sort((left, right) => left.groupSeq - right.groupSeq)) {
    let seq: number | null = null
    if (!exists) {
      const candidate = `${to}-${card.groupSeq}`
      if (!getCard(db, candidate) && !used.has(candidate)) seq = card.groupSeq
    }
    if (seq === null) {
      do {
        seq = nextSeq++
      } while (getCard(db, `${to}-${seq}`) || used.has(`${to}-${seq}`))
    }
    const target = `${to}-${seq}`
    used.add(target)
    mapping.push({ cardId: card.id, from: card.id, to: target, seq })
  }

  nextSeq = Math.max(nextSeq, ...mapping.map((item) => item.seq + 1), nextRow?.next_seq ?? 1)
  const result: GroupRenameResult = {
    from,
    to,
    cards: mapping.map((item) => ({ from: item.from, to: item.to })),
    created: !exists,
    dryRun: input.dryRun === true,
  }
  if (input.dryRun) return result

  return tx(db, () => {
    // FK на cards(id) без cascade: обновляем родителя и детей в одной транзакции.
    db.exec('pragma defer_foreign_keys = on')
    const at = nowIso()
    for (const item of mapping) {
      const card = getCard(db, item.cardId)!
      const legacy = [...card.legacyIds, card.id]
      db.prepare(
        'update cards set id = ?, group_prefix = ?, group_seq = ?, legacy_ids = ?, updated_at = ? where id = ?',
      ).run(item.to, to, item.seq, JSON.stringify(legacy), at, item.from)

      for (const table of ['steps', 'refs', 'discussion', 'run_cards', 'reviews', 'decisions']) {
        db.prepare(`update ${table} set card_id = ? where card_id = ?`).run(item.to, item.from)
      }
      db.prepare('update deps set from_id = ? where from_id = ?').run(item.to, item.from)
      db.prepare('update deps set to_id = ? where to_id = ?').run(item.to, item.from)
      db.prepare('update cards set origin_card_id = ? where origin_card_id = ?').run(
        item.to,
        item.from,
      )
      appendEvent(db, {
        type: 'card.rekeyed',
        actor: input.actor,
        subject: item.to,
        before: { id: item.from },
        after: { id: item.to },
      })
    }

    const name = input.name?.trim() ? input.name.trim() : null
    if (!exists) {
      db.prepare('insert into groups (prefix, next_seq, name, created_at) values (?, ?, ?, ?)').run(
        to,
        nextSeq,
        name,
        at,
      )
    } else {
      db.prepare(
        'update groups set next_seq = ?, name = coalesce(?, name) where prefix = ?',
      ).run(nextSeq, name, to)
    }
    db.prepare("delete from groups where prefix = ? and not exists (select 1 from cards where group_prefix = ?)").run(from, from)

    appendEvent(db, {
      type: 'group.renamed',
      actor: input.actor,
      subject: to,
      before: { prefix: from },
      after: { prefix: to, cards: mapping.length },
    })
    return result
  })
}
