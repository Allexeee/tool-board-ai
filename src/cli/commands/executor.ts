import { findProject } from '../../core/project.ts'
import { openDb } from '../../core/db.ts'
import { addExecutor, listExecutors } from '../../core/executors.ts'
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

  const rows = listExecutors(db)
  ok(
    rows,
    rows.length === 0
      ? 'исполнителей нет'
      : rows.map((e) => `${e.id.padEnd(12)} ${e.kind.padEnd(6)} ${e.skills.join(', ')}`).join('\n'),
  )
  return 0
}
