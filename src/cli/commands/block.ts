import { openDb } from '../../core/db.ts'
import { blockCard } from '../../core/lifecycle.ts'
import { findProject } from '../../core/project.ts'
import { stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const id = args.positionals[0]
    const actor = stringFlag(args, 'as')
    const reason = stringFlag(args, 'reason')
    if (!id || !actor || !reason) {
      throw new UserError(
        3,
        'использование: board block UI-1 --as developer --reason needs_decision --note «...»',
      )
    }

    const card = blockCard(db, { id, actor, reason, note: stringFlag(args, 'note') })
    ok(card, `${card.id} заблокирована: ${reason}`)
    return 0
  } finally {
    db.close()
  }
}
