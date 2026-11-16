import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { blockTask, type BlockReason } from '../../core/block.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const taskId = args.positionals[0]
  const executor = stringFlag(args, 'as')
  const reason = stringFlag(args, 'reason') as BlockReason | undefined
  const note = stringFlag(args, 'note') ?? ''

  if (!taskId || !executor || !reason) {
    throw new UserError(3, 'использование: block F1.S1-1 --as w1 --reason needs_data --note "чего не хватает"')
  }

  const task = blockTask(db, { taskId, executor, reason, note })
  ok(task, `${task.id}  ${task.status}  ${reason}: ${note}`)
  return 0
}
