import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { materialize, listRuns } from './runs.ts'
import { executeRun } from './execute.ts'
import { listRoutines } from './routines.ts'
import { listGates } from './gates.ts'
import { getQuestions, ask } from './questions.ts'
import { appendEvent } from './events.ts'

export interface TickResult {
  materialized: number
  executed: string[]
  escalated: string[]
}

export function tick(
  db: DatabaseSync,
  input: { root: string; now?: Date },
): TickResult {
  const now = input.now ?? new Date()

  return tx(db, () => {
    const created = materialize(db, { now })

    const due = listRuns(db).filter(
      (run) => run.status === 'planned' && run.dueAt <= now.toISOString(),
    )

    const executed: string[] = []
    for (const run of due) {
      executeRun(db, { runId: run.id, root: input.root })
      executed.push(run.id)
    }

    const escalated = escalate(db, now)

    return { materialized: created.length, executed, escalated }
  })
}

function escalate(db: DatabaseSync, now: Date): string[] {
  const escalated: string[] = []
  const pending = getQuestions(db, { addressee: 'owner', status: 'pending' })

  for (const routine of listRoutines(db)) {
    const runs = listRuns(db)
      .filter((run) => run.routineId === routine.id && run.dueAt <= now.toISOString())
      .slice(-3)

    if (runs.length < 3) continue
    if (!runs.every((run) => run.status === 'waiting_gate')) continue

    const already = pending.some((question) => question.subjectId === routine.id)
    if (already) continue

    const gates = listGates(db, routine.id).map((gate) => gate.name)
    ask(db, {
      addressee: 'owner',
      text: `рутина ${routine.name} стоит третий прогон подряд: гейты ${gates.join(', ')}`,
      subjectType: 'request',
      subjectId: routine.id,
      timeoutPolicy: 'block',
    })

    appendEvent(db, { type: 'run.escalated', actor: 'system', subject: routine.id })
    escalated.push(routine.id)
  }

  return escalated
}
