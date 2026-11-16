import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { touchTask } from '../../core/lease.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const taskId = args.positionals[0]
  const executor = stringFlag(args, 'as')
  if (!taskId || !executor) throw new UserError(3, 'использование: touch F1.S1-1 --as w1')

  const task = touchTask(db, { taskId, executor, leaseMinutes: project.config.leaseMinutes })
  ok(task, `${task.id}  аренда до ${task.leaseUntil}`)
  return 0
}
