import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'

export type IdKind = 'request' | 'feature' | 'stage' | 'task' | 'question'

const PREFIX: Record<IdKind, string> = {
  request: 'R',
  feature: 'F',
  stage: 'S',
  task: 'T',
  question: 'Q',
}

export function allocateId(db: DatabaseSync, kind: IdKind): string {
  const key = `counter.${kind}`

  return tx(db, () => {
    const row = db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined
    const next = row ? Number(row.value) + 1 : 1
    db.prepare(
      'insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
    ).run(key, String(next))
    return PREFIX[kind] + next
  })
}

export function childId(parent: string, kind: 'stage' | 'task', index: number): string {
  return kind === 'stage' ? `${parent}.S${index}` : `${parent}-${index}`
}

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
}

export function slugify(title: string): string {
  const mapped = Array.from(title.toLowerCase())
    .map((char) => TRANSLIT[char] ?? char)
    .join('')

  return mapped
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}
