import type { DatabaseSync } from 'node:sqlite'
import { listRuns } from './runs.ts'
import { listRoutines } from './routines.ts'
import { getQuestions } from './questions.ts'

export interface CalendarItem {
  at: string
  kind: 'routine' | 'question'
  title: string
  detail?: string
}

export function cal(
  db: DatabaseSync,
  options: { days?: number; now?: Date } = {},
): CalendarItem[] {
  const days = options.days ?? 7
  const now = options.now ?? new Date()
  const until = new Date(now.getTime() + days * 86_400_000).toISOString()

  const names = new Map(listRoutines(db).map((routine) => [routine.id, routine.name]))

  const runs: CalendarItem[] = listRuns(db, { from: now.toISOString(), to: until }).map((run) => ({
    at: run.dueAt,
    kind: 'routine',
    title: names.get(run.routineId) ?? run.routineId,
    detail: run.status,
  }))

  const questions: CalendarItem[] = getQuestions(db, { addressee: 'owner', status: 'pending' })
    .filter((question) => question.deadline && question.deadline <= until)
    .map((question) => ({
      at: question.deadline!,
      kind: 'question',
      title: question.text,
      detail: question.timeoutPolicy,
    }))

  return [...runs, ...questions].sort((a, b) => a.at.localeCompare(b.at))
}
