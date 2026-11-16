import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { reopenTask } from '../../core/done.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const taskId = args.positionals[0]
  const actor = stringFlag(args, 'as') ?? 'owner'
  const reason = stringFlag(args, 'reason') ?? ''

  if (!taskId) throw new UserError(3, 'использование: reopen F1.S1-1 --reason "что не так"')

  const task = reopenTask(db, { taskId, actor, reason })
  ok(task, `${task.id}  возвращена в работу`)
  return 0
}
