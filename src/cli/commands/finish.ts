import { refreshBacklogIfAuto } from '../../core/backlog.ts'
import { getCard } from '../../core/cards.ts'
import { openDb } from '../../core/db.ts'
import { finishCard } from '../../core/lifecycle.ts'
import { findProject } from '../../core/project.ts'
import { modelContext, resolveRunReviewMode } from '../../core/review-policy.ts'
import { getRun } from '../../core/runs.ts'
import { readSettings } from '../../core/settings.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const id = args.positionals[0]
    const actor = stringFlag(args, 'as')
    if (!id || !actor) {
      throw new UserError(3, 'использование: board finish UI-1 --as developer --summary «...»')
    }

    const existing = getCard(db, id)
    if (!existing) throw new UserError(3, `карточка ${id} не найдена`)
    const run = existing.runId ? getRun(db, existing.runId) : null
    const resolvedMode = run?.reviewMode ?? resolveRunReviewMode({
      settings: readSettings(project.root),
      context: modelContext(process.env),
    }).mode
    const forceReview = run !== null && resolvedMode !== 'none' && resolvedMode !== 'auto'

    const card = finishCard(db, {
      id,
      actor,
      summary: stringFlag(args, 'summary') ?? '',
      root: project.root,
      noMerge: boolFlag(args, 'no-merge'),
      mergeCommit: stringFlag(args, 'merge-commit'),
      forceReview,
    })
    ok(card, `${card.id} ${card.status === 'review' ? 'на ревью' : 'закрыта'}: ${card.title}`)
    try {
      refreshBacklogIfAuto(db, project.root)
    } catch (error) {
      process.stderr.write(`бэклог не обновлён: ${(error as Error).message}\n`)
    }
    return 0
  } finally {
    db.close()
  }
}
