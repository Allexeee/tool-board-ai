import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addExecutor, bindSession, getExecutor, listExecutors, resetSession } from '../../core/executors.ts'
import { listFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { ok } from '../output.ts'
import { UserError } from '../errors.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните toolbox-al init')
  const db = openDb(project.dbPath)

  if (args.sub === 'add') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'не указан id исполнителя')

    const skills = listFlag(args, 'skills')
      .flatMap((value) => value.split(','))
      .map((value) => value.trim())
      .filter(Boolean)

    const executor = addExecutor(db, {
      id,
      kind: (stringFlag(args, 'kind') as 'human' | 'agent') ?? 'agent',
      skills,
    })
    ok(executor, `${executor.id} добавлен: ${executor.skills.join(', ') || 'без навыков'}`)
    return 0
  }

  if (args.sub === 'bind') {
    const id = args.positionals[0]
    const session = stringFlag(args, 'session')
    if (!id || !session) throw new UserError(3, 'использование: executor bind w1 --session <ses_id>')

    const executor = bindSession(db, { executorId: id, session, actor: 'orchestrator' })
    ok(executor, `${executor.id}: сессия ${executor.session}`)
    return 0
  }

  if (args.sub === 'session') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor session w1')

    const executor = getExecutor(db, id)
    if (!executor) throw new UserError(3, `исполнитель ${id} не найден`)

    ok(executor, executor.session ? `${executor.id}: ${executor.session}` : `${executor.id}: сессия не привязана`)
    return 0
  }

  if (args.sub === 'reset') {
    const id = args.positionals[0]
    if (!id) throw new UserError(3, 'использование: executor reset w1')

    const executor = resetSession(db, { executorId: id, actor: 'orchestrator' })
    ok(executor, `${executor.id}: сессия отвязана`)
    return 0
  }

  const rows = listExecutors(db)
  ok(
    rows,
    rows.length === 0
      ? 'исполнителей нет'
      : rows.map((e) => `${e.id.padEnd(12)} ${e.kind.padEnd(6)} ${e.skills.join(', ')}`).join('\n'),
  )
  return 0
}

