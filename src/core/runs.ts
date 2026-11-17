import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { listRoutines } from './routines.ts'
import { nextRun, parseSchedule } from './schedule.ts'
import { UserError } from '../cli/errors.ts'

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

// ─── прогон (RUN): запись в базе, а не договорённость в чате ──────────────────
//
// Рутинный прогон выше отвечает на «когда по расписанию». Прогон здесь — это
// затея владельца: с какими запросами, в каком режиме, что утверждено, что
// будет с питанием. Открытый прогон один: второй старт без `run end` — отказ.

export type RunMode = 'plan' | 'all'
export type RunPower = 'none' | 'hibernate' | 'shutdown'

export interface RunRecord {
  id: string
  mode: RunMode
  requests: string[]
  nearest: boolean
  approve: boolean
  power: RunPower
  startedAt: string
  endedAt: string | null
  endReason: string | null
}

interface RunRow {
  id: string
  mode: string
  requests: string
  nearest: number
  approve: number
  power: string
  started_at: string
  ended_at: string | null
  end_reason: string | null
}

const RUN_MODES: readonly string[] = ['plan', 'all']
const RUN_POWERS: readonly string[] = ['none', 'hibernate', 'shutdown']

function runRequests(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

const toRunRecord = (row: RunRow): RunRecord => ({
  id: row.id,
  mode: row.mode as RunMode,
  requests: runRequests(row.requests),
  nearest: row.nearest === 1,
  approve: row.approve === 1,
  power: row.power as RunPower,
  startedAt: row.started_at,
  endedAt: row.ended_at,
  endReason: row.end_reason,
})

/**
 * Номер прогона: RUN1, RUN2, … Считается в meta, а не по строкам таблицы:
 * удалённый или закрытый прогон не должен выдавать номер повторно.
 */
function allocateRunId(db: DatabaseSync): string {
  const key = 'counter.workrun'
  const row = db.prepare('select value from meta where key = ?').get(key) as { value: string } | undefined
  const next = row ? Number(row.value) + 1 : 1

  db.prepare(
    'insert into meta (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
  ).run(key, String(next))

  return `RUN${next}`
}

function runList(db: DatabaseSync, where: string, params: string[]): RunRecord[] {
  return (
    db.prepare(`select * from runs${where ? ' where ' + where : ''} order by started_at, id`).all(
      ...params,
    ) as unknown as RunRow[]
  ).map(toRunRecord)
}

/** Открытый прогон: тот, у которого нет конца. Такой всегда один. */
export function activeRun(db: DatabaseSync): RunRecord | null {
  const rows = runList(db, 'ended_at is null', [])
  return rows.length > 0 ? rows[rows.length - 1] : null
}

/** Последний закрытый прогон: с него начинается разговор «что было в прошлый раз». */
export function lastClosedRun(db: DatabaseSync): RunRecord | null {
  const rows = runList(db, 'ended_at is not null', [])
  return rows.length > 0 ? rows[rows.length - 1] : null
}

export function getRunRecord(db: DatabaseSync, id: string): RunRecord | null {
  const row = db.prepare('select * from runs where id = ?').get(id) as RunRow | undefined
  return row ? toRunRecord(row) : null
}

export interface StartRunInput {
  mode: RunMode
  requests?: string[]
  nearest?: boolean
  approve?: boolean
  power?: RunPower
  actor?: string
  now?: Date
}

/**
 * Начать прогон. Взаимоисключающие варианты не угадываются: «ближайшие»
 * добирает 1-2 запроса сверху списка, «доталово» берёт всё до упора —
 * вместе это противоречие, о котором прямо и говорим.
 */
export function startRun(db: DatabaseSync, input: StartRunInput): RunRecord {
  const mode = input.mode
  if (!RUN_MODES.includes(mode)) {
    throw new UserError(3, `режим прогона бывает plan или all, а не ${String(mode)}`)
  }

  const power = input.power ?? 'none'
  if (!RUN_POWERS.includes(power)) {
    throw new UserError(3, `питание после прогона: none, hibernate или shutdown, а не ${String(power)}`)
  }

  if (input.nearest === true && mode === 'all') {
    throw new UserError(
      3,
      'выбор ближайших и режим доталово — это взаимоисключающие варианты: ' +
        'оставьте либо --nearest, либо --mode all',
    )
  }

  const requests = [...new Set((input.requests ?? []).map((id) => id.trim()).filter(Boolean))]

  return tx(db, () => {
    const open = activeRun(db)
    if (open) {
      throw new UserError(
        1,
        `прогон ${open.id} ещё не закрыт (начат ${open.startedAt}): сначала run end ${open.id}`,
      )
    }

    const run: RunRecord = {
      id: allocateRunId(db),
      mode,
      requests,
      nearest: input.nearest === true,
      approve: input.approve === true,
      power,
      startedAt: (input.now ?? new Date()).toISOString(),
      endedAt: null,
      endReason: null,
    }

    db.prepare(
      'insert into runs (id, mode, requests, nearest, approve, power, started_at, ended_at, end_reason) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      run.id,
      run.mode,
      JSON.stringify(run.requests),
      run.nearest ? 1 : 0,
      run.approve ? 1 : 0,
      run.power,
      run.startedAt,
      null,
      null,
    )

    appendEvent(db, {
      type: 'run.started',
      actor: input.actor ?? 'owner',
      subject: run.id,
      after: {
        mode: run.mode,
        requests: run.requests,
        nearest: run.nearest,
        approve: run.approve,
        power: run.power,
      },
    })

    return run
  })
}
