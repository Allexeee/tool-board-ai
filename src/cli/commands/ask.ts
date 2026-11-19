import { ask } from '../../core/discussion.ts'
import { openDb } from '../../core/db.ts'
import { blockCard } from '../../core/lifecycle.ts'
import { findProject } from '../../core/project.ts'
import { boolFlag, stringFlag, type ParsedArgs } from '../args.ts'
import { UserError } from '../errors.ts'
import { ok } from '../output.ts'

export default async function command(args: ParsedArgs) {
  const project = findProject(process.cwd())
  if (!project) throw new UserError(3, 'проект не найден: выполните board init')
  const db = openDb(project.dbPath)

  try {
    const cardId = args.positionals[0]
    const text = args.positionals.slice(1).join(' ')
    if (!cardId || !text) {
      throw new UserError(3, 'использование: board ask UI-1 "вопрос" --as developer [--block]')
    }

    const actor = stringFlag(args, 'as') ?? 'owner'
    const question = ask(db, {
      cardId,
      author: actor,
      text,
    })
    // --block: вопрос фиксируется, карточка ждёт решения владельца (§4.1).
    if (boolFlag(args, 'block')) {
      blockCard(db, { id: cardId, actor, reason: 'needs_decision', note: text })
    }
    ok(
      question,
      `${question.cardId} · вопрос #${question.id} задан: ${question.text} (спрашивает ${question.author})`,
    )
    return 0
  } finally {
    db.close()
  }
}
