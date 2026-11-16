import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { listRoutines } from './routines.ts'
import { nextRun, parseSchedule } from './schedule.ts'

export type RunStatus = 'planned' | 'running' | 'done' | 'partial' | 'waiting_gate' | 'skipped'

export interface RoutineRun {
  id: string
  routineId: string
  dueAt: string
  status: RunStatus
  startedAt: string | null
  finishedAt: string | null
  note: string | null
}

interface Row {
  id: string
  routine_id: string
  due_at: string
  status: RunStatus
  started_at: string | null
  finished_at: string | null
  note: string | null
}

const toRun = (row: Row): RoutineRun => ({
  id: row.id,
  routineId: row.routine_id,
  dueAt: row.due_at,
  status: row.status,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  note: row.note,
})

export function materialize(
  db: DatabaseSync,
  options: { now?: Date; leadHours?: number } = {},
): RoutineRun[] {
  const now = options.now ?? new Date()
  const leadHours = options.leadHours ?? 24
  const horizon = now.getTime() + leadHours * 3_600_000

  return tx(db, () => {
    const created: RoutineRun[] = []

    const catchUpFrom = new Date(now.getTime() - 24 * 3_600_000)

    for (const routine of listRoutines(db)) {
      const schedule = parseSchedule(routine.schedule)
      let due = nextRun(schedule, catchUpFrom)

      while (due.getTime() <= horizon) {
        const dueAt = due.toISOString()
        const exists = db
          .prepare('select 1 as found from routine_runs where routine_id = ? and due_at = ?')
          .get(routine.id, dueAt)

        if (!exists) {
          const run: RoutineRun = {
            id: allocateId(db, 'run'),
            routineId: routine.id,
            dueAt,
            status: 'planned',
            startedAt: null,
            finishedAt: null,
            note: null,
          }

          db.prepare(
            'insert into routine_runs (id, routine_id, due_at, status, started_at, finished_at, note) values (?, ?, ?, ?, ?, ?, ?)',
          ).run(run.id, run.routineId, run.dueAt, run.status, null, null, null)

          appendEvent(db, { type: 'run.planned', actor: 'system', subject: run.id, after: { dueAt } })
          created.push(run)
        }

        const next = nextRun(schedule, due)
        if (next.getTime() <= due.getTime()) break
        due = next
      }
    }

    return created
  })
}

export function listRuns(
  db: DatabaseSync,
  filter: { from?: string; to?: string } = {},
): RoutineRun[] {
  const where: string[] = []
  const params: string[] = []

  if (filter.from) {
    where.push('due_at >= ?')
    params.push(filter.from)
  }
  if (filter.to) {
    where.push('due_at <= ?')
    params.push(filter.to)
  }

  const sql =
    'select * from routine_runs' +
    (where.length ? ' where ' + where.join(' and ') : '') +
    ' order by due_at'

  return (db.prepare(sql).all(...params) as unknown as Row[]).map(toRun)
}

export function getRun(db: DatabaseSync, id: string): RoutineRun | null {
  const row = db.prepare('select * from routine_runs where id = ?').get(id) as Row | undefined
  return row ? toRun(row) : null
}
