import type { DatabaseSync } from 'node:sqlite'
import { allocateId } from './ids.ts'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { parseSchedule } from './schedule.ts'
import { UserError } from '../cli/errors.ts'

export type StepKind = 'agent' | 'mechanical'
export type OnMissing = 'block' | 'skip' | 'fallback'

export interface Routine {
  id: string
  name: string
  schedule: string
  window: string | null
  timezone: string
  guard: string | null
  escalatedAt: string | null
  createdAt: string
}

export interface RoutineStep {
  id: string
  routineId: string
  seq: number
  title: string
  kind: StepKind
  skill: string | null
  command: string | null
  dod: string[]
  scope: string[]
  onMissing: OnMissing
  createdAt: string
}

export function addRoutine(
  db: DatabaseSync,
  input: { name: string; schedule: string; window?: string; timezone?: string; guard?: string },
): Routine {
  parseSchedule(input.schedule)

  return tx(db, () => {
    const routine: Routine = {
      id: allocateId(db, 'routine'),
      name: input.name,
      schedule: input.schedule,
      window: input.window ?? null,
      timezone: input.timezone ?? 'local',
      guard: input.guard ?? null,
      escalatedAt: null,
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      'insert into routines (id, name, schedule, window, timezone, guard, created_at) values (?, ?, ?, ?, ?, ?, ?)',
    ).run(routine.id, routine.name, routine.schedule, routine.window, routine.timezone, routine.guard, routine.createdAt)

    appendEvent(db, { type: 'routine.added', actor: 'owner', subject: routine.id })
    return routine
  })
}

export function addStep(
  db: DatabaseSync,
  input: {
    routineId: string
    title: string
    kind: StepKind
    skill?: string
    command?: string
    dod?: string[]
    scope?: string[]
    onMissing?: OnMissing
  },
): RoutineStep {
  if (input.kind === 'agent' && !input.skill?.trim()) {
    throw new UserError(3, 'агентский шаг требует навык: --skill')
  }
  if (input.kind === 'mechanical' && !input.command?.trim()) {
    throw new UserError(3, 'механический шаг требует команду: --command')
  }

  return tx(db, () => {
    const seq =
      ((db.prepare('select coalesce(max(seq), 0) as s from routine_steps where routine_id = ?').get(input.routineId) as {
        s: number
      }).s || 0) + 1

    const step: RoutineStep = {
      id: `${input.routineId}-${seq}`,
      routineId: input.routineId,
      seq,
      title: input.title,
      kind: input.kind,
      skill: input.skill ?? null,
      command: input.command ?? null,
      dod: input.dod ?? [],
      scope: input.scope ?? [],
      onMissing: input.onMissing ?? 'block',
      createdAt: new Date().toISOString(),
    }

    db.prepare(
      'insert into routine_steps (id, routine_id, seq, title, kind, skill, command, dod, scope, on_missing, created_at) ' +
        'values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      step.id,
      step.routineId,
      step.seq,
      step.title,
      step.kind,
      step.skill,
      step.command,
      JSON.stringify(step.dod),
      JSON.stringify(step.scope),
      step.onMissing,
      step.createdAt,
    )

    appendEvent(db, { type: 'routine.step_added', actor: 'owner', subject: step.id })
    return step
  })
}

interface RoutineRow {
  id: string
  name: string
  schedule: string
  window: string | null
  timezone: string
  guard: string | null
  escalated_at: string | null
  created_at: string
}

const toRoutine = (row: RoutineRow): Routine => ({
  id: row.id,
  name: row.name,
  schedule: row.schedule,
  window: row.window,
  timezone: row.timezone,
  guard: row.guard,
  escalatedAt: row.escalated_at,
  createdAt: row.created_at,
})

export function listRoutines(db: DatabaseSync): Routine[] {
  return (db.prepare('select * from routines order by created_at, id').all() as unknown as RoutineRow[]).map(toRoutine)
}

export function getRoutine(db: DatabaseSync, id: string): Routine | null {
  const row = db.prepare('select * from routines where id = ?').get(id) as RoutineRow | undefined
  return row ? toRoutine(row) : null
}

interface StepRow {
  id: string
  routine_id: string
  seq: number
  title: string
  kind: StepKind
  skill: string | null
  command: string | null
  dod: string
  scope: string
  on_missing: OnMissing
  created_at: string
}

const toStep = (row: StepRow): RoutineStep => ({
  id: row.id,
  routineId: row.routine_id,
  seq: row.seq,
  title: row.title,
  kind: row.kind,
  skill: row.skill,
  command: row.command,
  dod: JSON.parse(row.dod) as string[],
  scope: JSON.parse(row.scope) as string[],
  onMissing: row.on_missing,
  createdAt: row.created_at,
})

export function listSteps(db: DatabaseSync, routineId: string): RoutineStep[] {
  return (
    db.prepare('select * from routine_steps where routine_id = ? order by seq').all(routineId) as unknown as StepRow[]
  ).map(toStep)
}
