import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

export function depsOf(db: DatabaseSync, id: string): string[] {
  return (db.prepare('select to_id from deps where from_id = ? order by to_id').all(id) as Array<{ to_id: string }>)
    .map((row) => row.to_id)
}

type EntityKind = 'task' | 'stage' | 'feature'

export function entityKind(db: DatabaseSync, id: string): EntityKind | null {
  if (db.prepare('select 1 as found from tasks where id = ?').get(id)) return 'task'
  if (db.prepare('select 1 as found from stages where id = ?').get(id)) return 'stage'
  if (db.prepare('select 1 as found from features where id = ?').get(id)) return 'feature'
  return null
}

export function isSatisfied(db: DatabaseSync, id: string): boolean {
  const kind = entityKind(db, id)
  if (kind === 'task') {
    const row = db.prepare('select status from tasks where id = ?').get(id) as { status: string }
    return row.status === 'done'
  }
  if (kind === 'stage') {
    const row = db.prepare('select status from stages where id = ?').get(id) as { status: string }
    return row.status === 'merged' || row.status === 'accepted'
  }
  if (kind === 'feature') {
    const row = db.prepare('select status from features where id = ?').get(id) as { status: string }
    return row.status === 'done'
  }
  return false
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

  return tx(db, () => {
    for (const id of [from, to]) {
      if (!entityKind(db, id)) throw new UserError(3, `зависимость: объект ${id} не найден`)
    }

    const cycle = wouldCycle(db, from, to)
    if (cycle) throw new UserError(3, `цикл зависимостей: ${cycle.join(' → ')}`)

    db.prepare('insert or ignore into deps (from_id, to_id) values (?, ?)').run(from, to)
    appendEvent(db, { type: 'dep.added', actor: 'system', subject: from, after: { dependsOn: to } })
  })
}

export function listDeps(db: DatabaseSync, id: string): string[] {
  return depsOf(db, id)
}

export function isReady(db: DatabaseSync, taskId: string): boolean {
  if (!stageAllowsWork(db, taskId)) return false

  const blockers = depsOf(db, taskId)
  if (blockers.some((blocker) => !isSatisfied(db, blocker))) return false

  const stage = db.prepare('select id, feature_id from stages where id = (select stage_id from tasks where id = ?)').get(taskId) as
    | { id: string; feature_id: string }
    | undefined

  if (stage) {
    if (depsOf(db, stage.id).some((blocker) => !isSatisfied(db, blocker))) return false
    if (depsOf(db, stage.feature_id).some((blocker) => !isSatisfied(db, blocker))) return false
  }

  return true
}

/** Работать можно только в активном этапе; задача пула этапа не имеет и активности не ждёт. */
function stageAllowsWork(db: DatabaseSync, taskId: string): boolean {
  const stage = db
    .prepare('select status from stages where id = (select stage_id from tasks where id = ?)')
    .get(taskId) as { status: string } | undefined

  if (!stage) return true

  return stage.status === 'active'
}

export function refreshReady(db: DatabaseSync): number {
  return tx(db, () => {
    const rows = db
      .prepare("select id from tasks where status in ('planned', 'open', 'ready')")
      .all() as Array<{ id: string }>

    let changed = 0
    for (const { id } of rows) {
      let wanted: 'planned' | 'ready' | 'open'
      if (!stageAllowsWork(db, id)) wanted = 'planned'
      else wanted = isReady(db, id) ? 'ready' : 'open'

      const result = db.prepare('update tasks set status = ? where id = ? and status != ?').run(wanted, id, wanted)
      if (Number(result.changes) > 0) changed++
    }
    return changed
  })
}
