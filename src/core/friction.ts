import type { DatabaseSync } from 'node:sqlite'
import { listTasks } from './tasks.ts'
import { listRuns } from './runs.ts'

export interface FrictionItem {
  name: string
  value: number
  hint: string
}

export function frictionReport(db: DatabaseSync, options: { days?: number } = {}): FrictionItem[] {
  const days = options.days ?? 7
  const since = new Date(Date.now() - days * 86_400_000).toISOString()

  const tasks = listTasks(db).filter((task) => task.createdAt >= since)
  const urgent = tasks.filter((task) => task.class === 'expedite')

  const reopenings = (
    db
      .prepare("select count(*) as c from events where type = 'task.reopened' and at >= ?")
      .get(since) as { c: number }
  ).c

  const exhausted = (
    db
      .prepare("select count(*) as c from events where type = 'task.attempts_exhausted' and at >= ?")
      .get(since) as { c: number }
  ).c

  const stuck = listRuns(db).filter(
    (run) => run.status === 'waiting_gate' && run.dueAt >= since,
  ).length

  const done = tasks.filter((task) => task.status === 'done').length
  const reopenRate = done > 0 ? Math.round((reopenings / done) * 100) : 0
  const urgentShare = tasks.length > 0 ? Math.round((urgent.length / tasks.length) * 100) : 0

  return [
    { name: 'доля срочного', value: urgentShare, hint: 'больше 30% — процесс не держит реальность' },
    { name: 'переоткрытия', value: reopenRate, hint: 'больше 15% — DoD пустой' },
    { name: 'попытки исчерпаны', value: exhausted, hint: 'задачи не по силам или плохой контекст' },
    { name: 'рутины в блоке', value: stuck, hint: 'гейт или механизм не готов' },
  ]
}
