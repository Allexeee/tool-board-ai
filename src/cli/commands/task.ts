import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { advanceTime } from '../../core/clock.ts'
import { createTask, editTask, getTask, listTasks, type EditableTask, type TaskClass, type TaskSize } from '../../core/tasks.ts'
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

  if (args.sub === 'edit') {
    const id = args.positionals[0]
    if (!id) {
      throw new UserError(3, 'использование: task edit F1.S1-1 --dod "…" --scope "src/**"')
    }

    const editable = ['title', 'dod', 'scope', 'size', 'size-reason', 'skill', 'class', 'kind', 'severity', 'check']
    const service = ['json', 'as', 'help', 'project']
    const given = Object.keys(args.flags).filter((name) => !service.includes(name))
    const unknown = given.filter((name) => !editable.includes(name))
    if (unknown.length > 0) {
      throw new UserError(
        3,
        `неизвестное поле: --${unknown[0]}. Допустимые: ${editable.map((name) => '--' + name).join(', ')}`,
      )
    }
    if (given.length === 0) {
      throw new UserError(3, 'нечего менять: укажите хотя бы одно поле')
    }

    const patch: EditableTask = {}
    if (given.includes('title')) patch.title = stringFlag(args, 'title')
    if (given.includes('dod')) patch.dod = listFlag(args, 'dod')
    if (given.includes('scope')) {
      const scopes = listFlag(args, 'scope')
      patch.scope = scopes.length === 1 && scopes[0] === 'exclusive' ? 'exclusive' : scopes
    }
    if (given.includes('size')) patch.size = stringFlag(args, 'size') as TaskSize
    if (given.includes('size-reason')) patch.sizeReason = stringFlag(args, 'size-reason')
    if (given.includes('skill')) patch.skill = stringFlag(args, 'skill')
    if (given.includes('class')) patch.class = stringFlag(args, 'class') as TaskClass
    if (given.includes('kind')) patch.kind = stringFlag(args, 'kind') as 'task' | 'defect' | 'incident'
    if (given.includes('severity')) patch.severity = stringFlag(args, 'severity') as 'S1' | 'S2' | 'S3' | 'S4'
    if (given.includes('check')) patch.checkCmd = stringFlag(args, 'check')

    const actor = stringFlag(args, 'as') ?? 'owner'
    const task = editTask(db, { id, actor, patch })
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
  // статусы пересчитываются перед показом: задача неактивного этапа честно зовётся planned
  advanceTime(db)
  const tasks = listTasks(db, stageId ? { stageId } : {})
  ok(
    tasks,
    tasks.length === 0
      ? 'задач нет'
      : tasks.map((t) => `${t.id.padEnd(10)} ${t.status.padEnd(10)} ${t.title}`).join('\n'),
  )
  return 0
}
