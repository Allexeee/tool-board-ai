import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { lastMovement, mergePoolTasks, poolTasks, removePoolTask, stalePoolTasks } from '../../core/pool.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  const days = Number(stringFlag(args, 'days') ?? 7)

  if (args.sub === 'remove') {
    const taskId = args.positionals[0]
    if (!taskId) throw new UserError(3, 'использование: pool remove T1 --reason "почему"')
    const task = removePoolTask(db, {
      taskId,
      actor: 'owner',
      reason: stringFlag(args, 'reason') ?? '',
    })
    ok(task, `${task.id} убрана из пула`)
    return 0
  }

  if (args.sub === 'merge') {
    const from = args.positionals[0]
    const to = args.positionals[1]
    if (!from || !to) throw new UserError(3, 'использование: pool merge T1 T2')
    const task = mergePoolTasks(db, { from, to, actor: 'owner' })
    ok(task, `${from} → ${to}, DoD объединены`)
    return 0
  }

  const tasks = args.sub === 'stale' ? stalePoolTasks(db, days) : poolTasks(db)

  ok(
    tasks,
    tasks.length === 0
      ? 'пул пуст'
      : tasks
          .map((task) => {
            const age = Math.floor((Date.now() - Date.parse(lastMovement(db, task.id))) / 86_400_000)
            return `${task.id.padEnd(6)} ${task.status.padEnd(10)} ${task.class.padEnd(11)} ${task.size.padEnd(3)} ${age}д  ${task.title}`
          })
          .join('\n'),
  )
  return 0
}

