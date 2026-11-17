import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent, listEvents } from './events.ts'
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
export type RunEndReason = 'owner' | 'tasks' | 'decision'
export type RunVerdict = 'ok' | 'found'

/** Почему прогон закончился: остановил владелец, кончились задачи, нужно решение. */
export type RunReviewState = 'open' | 'not_required' | 'needs_review' | 'found' | 'ready'

export interface RunReview {
  verdict: RunVerdict
  note: string | null
  at: string
  actor: string
}

export interface RunRecord {
  id: string
  mode: RunMode
  requests: string[]
  nearest: boolean
  approve: boolean
  power: RunPower
  startedAt: string
  endedAt: string | null
  endReason: RunEndReason | null
  /** Остановка владельцем ревью не требует; всё остальное — требует. */
  reviewRequired: boolean
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
const RUN_END_REASONS: readonly string[] = ['owner', 'tasks', 'decision']
const RUN_VERDICTS: readonly string[] = ['ok', 'found']

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
  endReason: row.end_reason as RunEndReason | null,
  reviewRequired: row.ended_at !== null && row.end_reason !== 'owner',
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
      reviewRequired: false,
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

export interface EndRunInput {
  id: string
  reason: RunEndReason
  actor?: string
  now?: Date
}

/**
 * Закрыть прогон с причиной. Прогон закрывается один раз: повторный end —
 * отказ, а не тихое переписывание конца. Остановка владельцем ревью не
 * требует, «задачи» и «решение» — требуют: непроверенный код к релизу не идёт.
 */
export function endRun(db: DatabaseSync, input: EndRunInput): RunRecord {
  return tx(db, () => {
    if (!RUN_END_REASONS.includes(input.reason)) {
      throw new UserError(
        3,
        `причина конца прогона: owner, tasks или decision, а не ${String(input.reason)}`,
      )
    }

    const run = getRunRecord(db, input.id)
    if (!run) throw new UserError(3, `прогон ${input.id} не найден`)
    if (run.endedAt) {
      throw new UserError(
        1,
        `прогон ${run.id} уже закрыт ${run.endedAt} (причина: ${run.endReason ?? 'не указана'}): ` +
          'второй run end не нужен',
      )
    }

    const endedAt = (input.now ?? new Date()).toISOString()
    db.prepare('update runs set ended_at = ?, end_reason = ? where id = ? and ended_at is null').run(
      endedAt,
      input.reason,
      run.id,
    )

    appendEvent(db, {
      type: 'run.ended',
      actor: input.actor ?? 'owner',
      subject: run.id,
      after: { reason: input.reason, reviewRequired: input.reason !== 'owner' },
    })

    return getRunRecord(db, run.id)!
  })
}

export interface ReviewRunInput {
  id: string
  verdict: RunVerdict
  note?: string
  actor?: string
}

/**
 * Отметка ревью закрытого прогона. Замечания без описания бесполезны,
 * поэтому `found` требует note. Связь с релизом появится отдельной задачей:
 * здесь важно только «проверено / не проверено» в самой записи прогона.
 */
export function reviewRun(db: DatabaseSync, input: ReviewRunInput): RunRecord {
  return tx(db, () => {
    if (!RUN_VERDICTS.includes(input.verdict)) {
      throw new UserError(3, `вердикт ревью: ok или found, а не ${String(input.verdict)}`)
    }

    const run = getRunRecord(db, input.id)
    if (!run) throw new UserError(3, `прогон ${input.id} не найден`)
    if (!run.endedAt) {
      throw new UserError(
        1,
        `прогон ${run.id} ещё идёт: ревью ставится закрытому прогону, сначала run end ${run.id}`,
      )
    }

    const note = input.note?.trim() ? input.note.trim() : null
    if (input.verdict === 'found' && note === null) {
      throw new UserError(3, 'ревью с замечаниями требует --note: что именно нашло')
    }

    appendEvent(db, {
      type: 'run.reviewed',
      actor: input.actor ?? 'owner',
      subject: run.id,
      after: { verdict: input.verdict, note },
    })

    return getRunRecord(db, run.id)!
  })
}

/** Последняя отметка ревью прогона: ревью переставляется, живёт последняя. */
export function reviewOf(db: DatabaseSync, id: string): RunReview | null {
  const events = listEvents(db, { subject: id }).filter((event) => event.type === 'run.reviewed')
  const last = events[events.length - 1]
  if (!last || !last.after) return null

  try {
    const parsed = JSON.parse(last.after) as { verdict?: string; note?: string | null }
    if (parsed.verdict !== 'ok' && parsed.verdict !== 'found') return null
    return { verdict: parsed.verdict, note: parsed.note ?? null, at: last.at, actor: last.actor }
  } catch {
    return null
  }
}

/**
 * Готовность прогона к релизу: открытый прогон ещё не готов, остановленный
 * владельцем ревью не проходил, «задачи» и «решение» ждут ревью, а after
 * вердикта ok — готов (найденное — не готов).
 */
export function reviewState(run: RunRecord, review: RunReview | null): RunReviewState {
  if (run.endedAt === null) return 'open'
  if (review) return review.verdict === 'found' ? 'found' : 'ready'
  return run.reviewRequired ? 'needs_review' : 'not_required'
}
