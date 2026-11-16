import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { createTask, getTask, listTasks, type TaskClass, type TaskSize } from '../../core/tasks.ts'
import { listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const first = args.positionals[0] ?? stringFlag(args, 'stage')
    const isStage = first ? /^F\d+\.S\d+$/.test(first) : false

    const stageId = isStage ? first : null
    const title = (isStage ? args.positionals[1] : first) ?? stringFlag(args, 'title')
    if (!title) {
      throw new UserError(3, 'использование: task add F1.S1 "Заголовок" … или task add "Заголовок" … для пула')
    }

    const scopes = listFlag(args, 'scope')
    const scope = scopes.length === 1 && scopes[0] === 'exclusive' ? 'exclusive' as const : scopes

    const task = createTask(db, {
      stageId,
      title,
      dod: listFlag(args, 'dod'),
      size: (stringFlag(args, 'size') as TaskSize) ?? 'S',
      sizeReason: stringFlag(args, 'size-reason'),
      skill: stringFlag(args, 'skill') ?? '',
      class: (stringFlag(args, 'class') as TaskClass) ?? 'standard',
      scope,
      kind: (stringFlag(args, 'kind') as 'task' | 'defect' | 'incident') ?? 'task',
      severity: stringFlag(args, 'severity') as 'S1' | 'S2' | 'S3' | 'S4' | undefined,
      review: (stringFlag(args, 'review') as 'none' | 'agent' | 'owner') ?? 'agent',
      checkCmd: stringFlag(args, 'check'),
    })

    ok(task, `${task.id}  ${task.size}  ${task.skill}  ${task.title}`)
    return 0
  }

  if (args.sub === 'show') {
    const task = getTask(db, args.positionals[0] ?? '')
    if (!task) throw new UserError(3, 'задача не найдена')
    ok(
      task,
      [
        `${task.id}  ${task.title}`,
        `размер: ${task.size} · навык: ${task.skill} · класс: ${task.class}`,
        `статус: ${task.status}${task.holder ? ' · держит ' + task.holder : ''}`,
        `DoD: ${task.dod.join('; ')}`,
        `область: ${task.scope === 'exclusive' ? 'эксклюзивно' : task.scope.join(', ')}`,
      ].join('\n'),
    )
    return 0
  }

  const stageId = args.positionals[0] ?? stringFlag(args, 'stage')
  const tasks = listTasks(db, stageId ? { stageId } : {})
  ok(
    tasks,
    tasks.length === 0
      ? 'задач нет'
      : tasks.map((t) => `${t.id.padEnd(10)} ${t.status.padEnd(10)} ${t.title}`).join('\n'),
  )
  return 0
}
