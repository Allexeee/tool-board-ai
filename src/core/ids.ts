import type { DatabaseSync } from 'node:sqlite'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { normalizeGroupPrefix } from './groups.ts'

export type IdKind = 'run' | 'decision'

const PREFIX: Record<IdKind, string> = {
  run: 'RUN-',
  decision: 'D',
}

/** Выдаёт `<группа>-<n>`; счётчик группы растёт в транзакции и не переиспользуется. */
export function allocateGroupId(db: DatabaseSync, prefix: string): string {
  const group = normalizeGroupPrefix(prefix)

  return tx(db, () => {
    const row = db.prepare('select next_seq from groups where prefix = ?').get(group) as
      | { next_seq: number }
      | undefined

    if (!row) {
      db.prepare('insert into groups (prefix, next_seq, created_at) values (?, 2, ?)').run(
        group,
        nowIso(),
      )
      return `${group}-1`
    }

    db.prepare('update groups set next_seq = next_seq + 1 where prefix = ?').run(group)
    return `${group}-${row.next_seq}`
  })
}

/** Служебные ID (RUN-1, D1) из счётчиков meta. */
export function allocateId(db: DatabaseSync, kind: IdKind): string {
  const key = `counter.${kind}`

  return tx(db, () => {
    const row = db.prepare('select value from meta where key = ?').get(key) as
      | { value: string }
      | undefined
    const next = row ? Number(row.value) + 1 : 1
    db.prepare(
      'insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
    ).run(key, String(next))
    return PREFIX[kind] + next
  })
}
