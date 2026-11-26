import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import type { Card } from './types.ts'

/** Три варианта забега: тег карточки и подпись. */
export const RUN_VARIANTS = [
  { tag: 'new', label: 'НОВОЕ' },
  { tag: 'improve', label: 'УЛУЧШЕНИЕ' },
  { tag: 'review', label: 'ПОСЛЕ РЕВЬЮ' },
] as const

export type RunVariant = (typeof RUN_VARIANTS)[number]

/** Первый вариантный тег в порядке new → improve → review. */
export function variantOf(card: Card): RunVariant | null {
  for (const variant of RUN_VARIANTS) {
    if (card.tags.includes(variant.tag)) return variant
  }
  return null
}

export function isVariantTag(tag: string): boolean {
  return RUN_VARIANTS.some((variant) => variant.tag === tag)
}

/** Служебные теги: ставятся доской и не удаляются вручную. */
export const SERVICE_TAGS = ['new', 'improve', 'review', 'idea'] as const

const TAG = /^[a-z0-9][a-z0-9._-]*$/

export interface Tag {
  name: string
  description: string | null
  createdAt: string
  count: number
}

interface Row {
  name: string
  description: string | null
  created_at: string
  count?: number
}

export function normalizeTagName(raw: string): string {
  const name = raw.trim().toLowerCase()
  if (!TAG.test(name)) {
    throw new UserError(
      3,
      `недопустимый тег «${raw}»: одно слово из латиницы, цифр, точки, дефиса или подчёркивания`,
    )
  }
  return name
}

function toTag(row: Row): Tag {
  return {
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    count: row.count ?? 0,
  }
}

export function tagExists(db: DatabaseSync, name: string): boolean {
  return db.prepare('select 1 as found from tags where name = ?').get(name) !== undefined
}

function requireTag(db: DatabaseSync, name: string): Tag {
  const row = db
    .prepare(
      `select t.name, t.description, t.created_at,
              (select count(*) from cards c
                where exists (select 1 from json_each(c.tags) where json_each.value = t.name)) as count
       from tags t where t.name = ?`,
    )
    .get(name) as Row | undefined
  if (!row) throw new UserError(3, `тег «${name}» не найден: добавьте board tag add ${name}`)
  return toTag(row)
}

/** Теги карточки: нормализует и проверяет по реестру. */
export function assertKnownTags(db: DatabaseSync, raw: string[]): string[] {
  const tags = [...new Set(raw.map(normalizeTagName).filter(Boolean))]
  for (const tag of tags) {
    if (!tagExists(db, tag)) {
      throw new UserError(3, `тег «${tag}» не найден: добавьте board tag add ${tag}`)
    }
  }
  return tags
}

export function addTag(
  db: DatabaseSync,
  input: { name: string; description?: string | null; actor?: string },
): Tag {
  return tx(db, () => {
    const name = normalizeTagName(input.name)
    if (tagExists(db, name)) throw new UserError(3, `тег «${name}» уже есть`)
    const actor = input.actor?.trim() || 'owner'
    const description = input.description?.trim() || null
    db.prepare('insert into tags (name, description, created_at) values (?, ?, ?)').run(
      name,
      description,
      nowIso(),
    )
    appendEvent(db, {
      type: 'tag.added',
      actor,
      subject: name,
      after: { name, description },
    })
    return requireTag(db, name)
  })
}

export function listTags(db: DatabaseSync): Tag[] {
  const rows = db
    .prepare(
      `select t.name, t.description, t.created_at,
              (select count(*) from cards c
                where exists (select 1 from json_each(c.tags) where json_each.value = t.name)) as count
       from tags t order by t.name`,
    )
    .all() as unknown as Row[]
  return rows.map(toTag)
}

/** Переименование обновляет и реестр, и tags у всех карточек. */
export function renameTag(
  db: DatabaseSync,
  input: { from: string; to: string; actor?: string },
): Tag {
  return tx(db, () => {
    const from = normalizeTagName(input.from)
    const to = normalizeTagName(input.to)
    if (from === to) return requireTag(db, from)
    if (!tagExists(db, from)) throw new UserError(3, `тег «${from}» не найден`)
    if (tagExists(db, to)) throw new UserError(3, `тег «${to}» уже есть`)
    const actor = input.actor?.trim() || 'owner'
    const at = nowIso()

    db.prepare('update tags set name = ? where name = ?').run(to, from)

    const cards = db.prepare('select id, tags from cards').all() as Array<{
      id: string
      tags: string
    }>
    for (const card of cards) {
      const tags = JSON.parse(card.tags) as string[]
      if (!tags.includes(from)) continue
      const next = [...new Set(tags.map((tag) => (tag === from ? to : tag)))]
      db.prepare('update cards set tags = ?, updated_at = ? where id = ?').run(
        JSON.stringify(next),
        at,
        card.id,
      )
    }

    appendEvent(db, {
      type: 'tag.renamed',
      actor,
      subject: to,
      before: { name: from },
      after: { name: to },
    })
    return requireTag(db, to)
  })
}

/** Удаление только свободного тега: занятый сначала снимают с карточек. */
export function removeTag(
  db: DatabaseSync,
  input: { name: string; actor?: string },
): Tag {
  return tx(db, () => {
    const name = normalizeTagName(input.name)
    if ((SERVICE_TAGS as readonly string[]).includes(name)) {
      throw new UserError(3, `служебный тег «${name}» удалить нельзя`)
    }
    const tag = requireTag(db, name)
    if (tag.count > 0) {
      const ids = (
        db
          .prepare(
            `select c.id from cards c
             where exists (select 1 from json_each(c.tags) where json_each.value = ?)
             order by c.id limit 5`,
          )
          .all(name) as Array<{ id: string }>
      ).map((row) => row.id)
      const rest = tag.count > ids.length ? ` и ещё ${tag.count - ids.length}` : ''
      throw new UserError(3, `тег «${name}» занят карточками: ${ids.join(', ')}${rest}`)
    }
    db.prepare('delete from tags where name = ?').run(name)
    appendEvent(db, {
      type: 'tag.removed',
      actor: input.actor?.trim() || 'owner',
      subject: name,
    })
    return tag
  })
}

/** Служебный тег для системы: добавляет, если реестр потерял его. */
export function ensureTag(db: DatabaseSync, name: string, actor = 'system'): void {
  const normalized = normalizeTagName(name)
  if (tagExists(db, normalized)) return
  db.prepare('insert into tags (name, description, created_at) values (?, ?, ?)').run(
    normalized,
    'служебный',
    nowIso(),
  )
  appendEvent(db, {
    type: 'tag.added',
    actor,
    subject: normalized,
    after: { name: normalized, service: true },
  })
}
