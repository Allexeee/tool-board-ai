import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { dispatchPlan } from '../../core/views.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command() {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const plan = dispatchPlan(db)

  const lines = plan.assignments.map((entry) => {
    const hand = entry.tasks.length ? entry.tasks.join(', ') : '—'
    const session = entry.session ? `  сессия: ${entry.session}` : ''
    return `${entry.executor.padEnd(12)} рука: ${hand}${entry.newTask ? '  → ' + entry.newTask : ''}${session}`
  })

  const text =
    lines.join('\n') + (plan.warnings.length ? '\n\n' + plan.warnings.map((w) => '! ' + w).join('\n') : '')

  ok(plan, text || 'распределять нечего')
  return 0
}
