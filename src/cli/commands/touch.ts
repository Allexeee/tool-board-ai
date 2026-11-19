import { openDb } from '../../core/db.ts'
import { touchCard } from '../../core/lifecycle.ts'
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
    if (!id || !actor) {
      throw new UserError(3, 'использование: board touch UI-1 --as developer')
    }

    const card = touchCard(db, { id, actor })
    ok(card, `${card.id} · аренда продлена до ${card.leaseUntil}`)
    return 0
  } finally {
    db.close()
  }
}
