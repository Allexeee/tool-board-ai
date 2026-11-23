import { openDb } from '../../core/db.ts'
import { getCard } from '../../core/cards.ts'
import { takeCard } from '../../core/lifecycle.ts'
import { findProject } from '../../core/project.ts'
import { modelContext, resolveSpecReviewMode } from '../../core/review-policy.ts'
import { readSettings } from '../../core/settings.ts'
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
      throw new UserError(3, 'использование: board take UI-1 --as developer')
    }

    // Тот же spec-гейт, что у submit: promotion запроса его не обходит.
    const existing = getCard(db, id)
    const resolution = resolveSpecReviewMode({
      settings: readSettings(project.root),
      specLength: (existing?.body.length ?? 0) + (existing?.acceptance.length ?? 0),
      context: modelContext(process.env),
    })

    const card = takeCard(db, {
      id,
      actor,
      root: project.root,
      noPlan: boolFlag(args, 'no-plan'),
      requiredSpecReview: {
        mode: resolution.mode,
        reviewerModel: resolution.reviewerModel,
      },
    })
    const state = card.phase === 'request' ? 'в разборе' : 'в работе'
    ok(card, `${card.id} ${state}: ${card.title}${card.branch ? ` · ветка ${card.branch}` : ''}`)
    return 0
  } finally {
    db.close()
  }
}
