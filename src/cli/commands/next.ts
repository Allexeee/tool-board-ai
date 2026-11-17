import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { getTask } from '../../core/tasks.ts'
import { getHand, nextTask } from '../../core/hands.ts'
import { waitingReason } from '../../core/lease.ts'
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

  const task = nextTask(db, executor)
  if (!task) {
    // рука может быть полна будущими шагами: это не «делать нечего», а ожидание цепочки
    const hand = getHand(db, executor)
    process.stderr.write(hand.length > 0 ? `${waitingReason(db, hand)}\n` : 'делать нечего\n')
    return 1
  }

  ok(task, `${task.id}  ${task.size}  ${task.title}`)
  return 0
}
