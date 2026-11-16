import { spawnSync } from 'node:child_process'
import type { DatabaseSync } from 'node:sqlite'
import { tx } from './db.ts'
import { appendEvent } from './events.ts'
import { listSteps, type RoutineStep } from './routines.ts'
import { checkGate, listGates } from './gates.ts'
import { getRun } from './runs.ts'
import { createTask } from './tasks.ts'
import { UserError } from '../cli/errors.ts'

export type RunOutcome = 'done' | 'partial' | 'waiting_gate' | 'skipped'

export interface StepResult {
  step: RoutineStep
  result: string
}

export interface ExecuteResult {
  status: RunOutcome
  steps: StepResult[]
}

function runCommand(root: string, command: string): { ok: boolean; output: string } {
  const result =
    process.platform === 'win32'
      ? spawnSync('cmd.exe', ['/c', command], { cwd: root, encoding: 'utf8' })
      : spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8' })

  return {
    ok: result.status === 0,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() || `код ${result.status}`,
  }
}

export function executeRun(
  db: DatabaseSync,
  input: { runId: string; root: string },
): ExecuteResult {
  return tx(db, () => {
    const run = getRun(db, input.runId)
    if (!run) throw new UserError(3, `прогон ${input.runId} не найден`)
    if (run.status !== 'planned') return { status: run.status as RunOutcome, steps: [] }

    db.prepare("update routine_runs set status = 'running', started_at = ? where id = ?").run(
      new Date().toISOString(),
      run.id,
    )

    const steps = listSteps(db, run.routineId)
    const gates = listGates(db, run.routineId)
    const results: StepResult[] = []
    let outcome: RunOutcome = 'done'

    for (const step of steps) {
      const relevant = gates.filter((gate) => gate.stepId === null || gate.stepId === step.id)
      const failed = relevant
        .map((gate) => ({ gate, check: checkGate(db, gate, { root: input.root }) }))
        .filter((item) => !item.check.ok)

      if (failed.length > 0) {
        const reason = failed.map((item) => item.check.reason).join('; ')

        if (step.onMissing === 'skip') {
          results.push({ step, result: `пропущено: ${reason}` })
          continue
        }

        if (step.onMissing === 'fallback') {
          const task = createTask(db, {
            id: `${run.id}-${step.seq}`,
            stageId: null,
            title: `${step.title} (вручную)`,
            dod: step.dod.length ? step.dod : ['сделано вручную'],
            size: 'S',
            skill: step.skill ?? 'general',
            class: 'standard',
            scope: step.scope.length ? step.scope : 'exclusive',
          })
          results.push({ step, result: `передано вручную: задача ${task.id}` })
          continue
        }

        db.prepare("update routine_runs set status = 'waiting_gate', note = ? where id = ?").run(reason, run.id)
        appendEvent(db, { type: 'run.waiting_gate', actor: 'system', subject: run.id, note: reason })
        results.push({ step, result: `ждёт гейта: ${reason}` })
        return { status: 'waiting_gate', steps: results }
      }

      if (step.kind === 'mechanical') {
        const result = runCommand(input.root, step.command ?? '')
        results.push({ step, result: result.output })
        if (!result.ok) outcome = outcome === 'done' ? 'partial' : outcome
        continue
      }

      const task = createTask(db, {
        id: `${run.id}-${step.seq}`,
        stageId: null,
        title: step.title,
        dod: step.dod.length ? step.dod : ['сделано'],
        size: 'S',
        skill: step.skill ?? 'general',
        class: 'standard',
        scope: step.scope.length ? step.scope : 'exclusive',
      })
      results.push({ step, result: `задача ${task.id}` })
    }

    db.prepare('update routine_runs set status = ?, finished_at = ? where id = ?').run(
      outcome,
      new Date().toISOString(),
      run.id,
    )
    appendEvent(db, { type: 'run.finished', actor: 'system', subject: run.id, note: outcome })

    return { status: outcome, steps: results }
  })
}
