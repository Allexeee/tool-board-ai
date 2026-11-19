import { openDb } from '../../core/db.ts'
import { finishCard } from '../../core/lifecycle.ts'
import { findProject } from '../../core/project.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
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
      throw new UserError(3, 'использование: board finish UI-1 --as developer --summary «...»')
    }

    const card = finishCard(db, {
      id,
      actor,
      summary: stringFlag(args, 'summary') ?? '',
      root: project.root,
      noMerge: boolFlag(args, 'no-merge'),
      mergeCommit: stringFlag(args, 'merge-commit'),
    })
    ok(card, `${card.id} ${card.status === 'review' ? 'на ревью' : 'закрыта'}: ${card.title}`)
    return 0
  } finally {
    db.close()
  }
}
