import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

export function depsOf(db: DatabaseSync, id: string): string[] {
  return (db.prepare('select to_id from deps where from_id = ? order by to_id').all(id) as Array<{ to_id: string }>)
    .map((row) => row.to_id)
}

function pathBetween(db: DatabaseSync, start: string, goal: string): string[] | null {
  const previous = new Map<string, string>()
  const seen = new Set<string>([start])
  const stack = [start]

  while (stack.length > 0) {
    const current = stack.pop()!
    if (current === goal) {
      const path = [current]
      let cursor = current
      while (cursor !== start) {
        cursor = previous.get(cursor)!
        path.unshift(cursor)
      }
      return path
    }
    for (const next of depsOf(db, current)) {
      if (seen.has(next)) continue
      seen.add(next)
      previous.set(next, current)
      stack.push(next)
    }
  }

  return null
}

export function wouldCycle(db: DatabaseSync, from: string, to: string): string[] | null {
  const path = pathBetween(db, to, from)
  return path ? [...path, to] : null
}

export function addDep(db: DatabaseSync, from: string, to: string): void {
  if (from === to) throw new UserError(3, `цикл: ${from} не может зависеть от себя`)

  const cycle = wouldCycle(db, from, to)
  if (cycle) throw new UserError(3, `цикл зависимостей: ${cycle.join(' → ')}`)

  tx(db, () => {
    db.prepare('insert or ignore into deps (from_id, to_id) values (?, ?)').run(from, to)
    appendEvent(db, { type: 'dep.added', actor: 'system', subject: from, after: { dependsOn: to } })
  })
}

export function listDeps(db: DatabaseSync, id: string): string[] {
  return depsOf(db, id)
}

export function isReady(db: DatabaseSync, taskId: string): boolean {
  const blockers = depsOf(db, taskId)
  if (blockers.length === 0) return true

  const placeholders = blockers.map(() => '?').join(', ')
  const row = db
    .prepare(`select count(*) as pending from tasks where id in (${placeholders}) and status != 'done'`)
    .get(...blockers) as { pending: number }

  return row.pending === 0
}

export function refreshReady(db: DatabaseSync): number {
  return tx(db, () => {
    const rows = db
      .prepare("select id from tasks where status in ('open', 'ready')")
      .all() as Array<{ id: string }>

    let changed = 0
    for (const { id } of rows) {
      const ready = isReady(db, id)
      const wanted = ready ? 'ready' : 'open'
      const result = db.prepare('update tasks set status = ? where id = ? and status != ?').run(wanted, id, wanted)
      if (Number(result.changes) > 0) changed++
    }
    return changed
  })
}
