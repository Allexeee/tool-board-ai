import { spawnSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { materialize, listRuns, getRun } from './runs.ts'
import { executeRun } from './execute.ts'
import { getRoutine, listRoutines } from './routines.ts'
import { listGates } from './gates.ts'
import { getQuestions, ask } from './questions.ts'
import { appendEvent } from './events.ts'
import { inWindow } from './schedule.ts'

export interface TickResult {
  materialized: number
  executed: string[]
  escalated: string[]
  deferred: string[]
}

function shell(root: string, command: string): boolean {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', command], { cwd: root, encoding: 'utf8' })
      : spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' })
  return result.status === 0
}

export function tick(db: DatabaseSync, input: { root: string; now?: Date }): TickResult {
  const now = input.now ?? new Date()

  return tx(db, () => {
    const created = materialize(db, { now })

    const due = listRuns(db).filter(
      (run) => run.status === 'planned' && run.dueAt <= now.toISOString(),
    )

    const executed: string[] = []
    const deferred: string[] = []

    for (const run of due) {
      const routine = getRoutine(db, run.routineId)
      if (!routine) continue

      if (!inWindow(routine.window, now)) {
        db.prepare("update routine_runs set note = 'вне окна' where id = ?").run(run.id)
        deferred.push(run.id)
        continue
      }

      if (routine.guard && !shell(input.root, routine.guard)) {
        db.prepare("update routine_runs set status = 'skipped', note = 'guard не выполнен' where id = ?").run(run.id)
        appendEvent(db, { type: 'run.skipped', actor: 'system', subject: run.id, note: routine.guard })
        continue
      }

      executeRun(db, { runId: run.id, root: input.root, now })
      executed.push(run.id)
    }

    const escalated = escalate(db, now)

    return { materialized: created.length, executed, escalated, deferred }
  })
}

function escalate(db: DatabaseSync, now: Date): string[] {
  const escalated: string[] = []
  const pending = getQuestions(db, { addressee: 'owner', status: 'pending' })

  for (const routine of listRoutines(db)) {
    const runs = listRuns(db)
      .filter((run) => run.routineId === routine.id && run.dueAt <= now.toISOString())
      .slice(-3)

    const stuck = runs.length === 3 && runs.every((run) => run.status === 'waiting_gate')

    if (!stuck) {
      if (routine.escalatedAt) {
        db.prepare('update routines set escalated_at = null where id = ?').run(routine.id)
      }
      continue
    }

    const already = pending.some((question) => question.subjectId === routine.id)
    if (routine.escalatedAt || already) continue

    const gates = listGates(db, routine.id).map((gate) => gate.name)
    ask(db, {
      addressee: 'owner',
      text: `рутина ${routine.name} стоит третий прогон подряд: гейты ${gates.join(', ')}`,
      subjectType: 'routine_step' as never,
      subjectId: routine.id,
      timeoutPolicy: 'block',
    })

    db.prepare('update routines set escalated_at = ? where id = ?').run(now.toISOString(), routine.id)
    appendEvent(db, { type: 'run.escalated', actor: 'system', subject: routine.id })
    escalated.push(routine.id)
  }

  return escalated
}

export { getRun }
