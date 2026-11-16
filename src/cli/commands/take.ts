import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { takeTask } from '../../core/lease.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)
  advanceTime(db)

  const executor = stringFlag(args, 'as')
  if (!executor) throw new UserError(3, 'не указан исполнитель: --as w1')

  const task = takeTask(db, {
    executor,
    taskId: args.positionals[0],
    leaseMinutes: project.config.leaseMinutes,
  })

  ok(task, `${task.id}  ${task.title}\nаренда до ${task.leaseUntil}`)
  return 0
}
