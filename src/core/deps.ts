import type { DatabaseSync } from 'node:sqlite'
import { UserError } from '../cli/errors.ts'
import { getCard } from './cards.ts'
import { nowIso } from './clock.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'

/** Зависимость — направленное ребро `from → to`: `from` ждёт закрытия `to`. */
const DEFAULT_ACTOR = 'system'

/** Прямые зависимости карточки: то, что должно закрыться раньше неё. */
export function listDeps(db: DatabaseSync, id: string): string[] {
  const rows = db
    .prepare('select to_id from deps where from_id = ? order by to_id')
    .all(id) as Array<{ to_id: string }>
  return rows.map((row) => row.to_id)
}

function requireCard(db: DatabaseSync, id: string): void {
  if (!getCard(db, id)) throw new UserError(3, `карточка ${id} не найдена`)
}

/** Путь по рёбрам зависимостей от `start` до `goal`; null — пути нет. */
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
    for (const next of listDeps(db, current)) {
      if (seen.has(next)) continue
      seen.add(next)
      previous.set(next, current)
      stack.push(next)
    }
  }

  return null
}

/**
 * Цикл, который появится после добавления ребра `from → to`.
 * Возвращает путь от `to` обратно к `from` и замыкающее ребро, иначе null.
 */
export function wouldCycle(db: DatabaseSync, from: string, to: string): string[] | null {
  const path = pathBetween(db, to, from)
  return path ? [...path, to] : null
}

/**
 * `insert or ignore` делает повторное добавление безопасным. Событие пишется
 * и на повтор: команда была, журнал её помнит.
 */
export function addDep(
  db: DatabaseSync,
  from: string,
  to: string,
  actor: string = DEFAULT_ACTOR,
): void {
  tx(db, () => {
    requireCard(db, from)
    requireCard(db, to)

    if (from === to) {
      throw new UserError(3, `цикл зависимостей: ${from} → ${to}`)
    }

    const cycle = wouldCycle(db, from, to)
    if (cycle) throw new UserError(3, `цикл зависимостей: ${cycle.join(' → ')}`)

    db.prepare('insert or ignore into deps (from_id, to_id) values (?, ?)').run(from, to)
    appendEvent(db, {
      type: 'dep.added',
      actor,
      subject: from,
      after: { dependsOn: to },
    })
  })
}

export function removeDep(
  db: DatabaseSync,
  from: string,
  to: string,
  actor: string = DEFAULT_ACTOR,
): void {
  tx(db, () => {
    requireCard(db, from)
    const result = db
      .prepare('delete from deps where from_id = ? and to_id = ?')
      .run(from, to)
    if (Number(result.changes) === 0) {
      throw new UserError(3, `зависимость ${from} → ${to} не найдена`)
    }
    appendEvent(db, {
      type: 'dep.removed',
      actor,
      subject: from,
      before: { dependedOn: to },
    })
  })
}

/** `review`/`done` закрывают зависимость; `cancelled` — только с waive_deps. */
export function isSatisfied(db: DatabaseSync, id: string): boolean {
  const card = getCard(db, id)
  if (!card) throw new UserError(3, `карточка ${id} не найдена`)
  if (card.status === 'review' || card.status === 'done') return true
  if (card.status === 'cancelled') return card.waiveDeps
  return false
}

/**
 * Пересчитывает готовность только у задач, которые уже стоят в ожидании:
 * `waiting` ↔ `ready`. Остальные статусы и фазы не трогаем — их ведут
 * явные переходы. Возвращает число изменённых карточек.
 */
export function refreshReadiness(db: DatabaseSync): number {
  return tx(db, () => {
    const rows = db
      .prepare(
        "select id, status from cards where phase = 'task' and status in ('waiting', 'ready') order by created_at, rowid",
      )
      .all() as Array<{ id: string; status: string }>

    let changed = 0
    for (const row of rows) {
      const ready = listDeps(db, row.id).every((dep) => isSatisfied(db, dep))
      const wanted = ready ? 'ready' : 'waiting'
      if (wanted === row.status) continue

      const before = getCard(db, row.id)!
      db.prepare('update cards set status = ?, updated_at = ? where id = ?').run(
        wanted,
        nowIso(),
        row.id,
      )
      const after = getCard(db, row.id)!
      appendEvent(db, {
        type: 'card.readiness',
        actor: DEFAULT_ACTOR,
        subject: row.id,
        before,
        after,
        note: ready ? 'зависимости закрыты' : 'зависимости не закрыты',
      })
      changed++
    }

    return changed
  })
}
